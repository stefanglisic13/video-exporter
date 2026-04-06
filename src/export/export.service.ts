import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { SegmentDto } from './dto/export-without-idle-time.dto';

const execPromise = promisify(exec);

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly tempDir: string;

  constructor(private readonly configService: ConfigService) {
    this.tempDir = this.configService.get<string>(
      'TEMP_DIR',
      '/tmp/video-exporter',
    );
  }

  async ensureTempDir(): Promise<void> {
    await fs.mkdir(this.tempDir, { recursive: true });
  }

  async downloadVideo(videoUrl: string): Promise<string> {
    await this.ensureTempDir();
    const inputPath = join(this.tempDir, `input-${Date.now()}.mp4`);

    this.logger.log(`Download start: ${videoUrl}`);
    try {
      await execPromise(`curl -fSL -o "${inputPath}" "${videoUrl}"`, {
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      throw new BadRequestException(
        `Failed to download video: ${(err as Error).message}`,
      );
    }
    this.logger.log(`Download end: ${inputPath}`);
    return inputPath;
  }

  private sortAndMergeSegments(segments: SegmentDto[]): SegmentDto[] {
    const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
    const merged: SegmentDto[] = [];

    for (const seg of sorted) {
      if (seg.startMs >= seg.endMs) continue;
      const last = merged[merged.length - 1];
      if (last && seg.startMs <= last.endMs) {
        last.endMs = Math.max(last.endMs, seg.endMs);
      } else {
        merged.push({ startMs: seg.startMs, endMs: seg.endMs });
      }
    }

    return merged;
  }

  async processVideo(
    inputPath: string,
    segments: SegmentDto[],
  ): Promise<string> {
    const merged = this.sortAndMergeSegments(segments);
    if (merged.length === 0) {
      throw new BadRequestException('No valid segments provided');
    }

    const outputPath = join(this.tempDir, `output-${Date.now()}.mp4`);
    const segmentPaths: string[] = [];

    try {
      for (let i = 0; i < merged.length; i++) {
        const start = merged[i].startMs / 1000;
        const duration = (merged[i].endMs - merged[i].startMs) / 1000;
        const segPath = join(this.tempDir, `seg-${Date.now()}-${i}.mp4`);
        segmentPaths.push(segPath);

        this.logger.log(
          `ffmpeg start: segment ${i + 1}/${merged.length} (${start}s, ${duration}s)`,
        );
        await execPromise(
          `ffmpeg -ss ${start} -i "${inputPath}" -t ${duration} -c copy "${outputPath}"`,
        );
        this.logger.log(`ffmpeg end: segment ${i + 1}/${merged.length}`);
      }

      if (segmentPaths.length === 1) {
        await fs.rename(segmentPaths[0], outputPath);
        segmentPaths.length = 0;
      } else {
        const concatListPath = join(this.tempDir, `concat-${Date.now()}.txt`);
        const concatContent = segmentPaths.map((p) => `file '${p}'`).join('\n');
        await fs.writeFile(concatListPath, concatContent);

        this.logger.log(`ffmpeg start: concat ${segmentPaths.length} segments`);
        await execPromise(
          `ffmpeg -f concat -safe 0 -i "${concatListPath}" -c copy "${outputPath}"`,
        );
        this.logger.log('ffmpeg end: concat');

        await fs.unlink(concatListPath).catch(() => {});
      }

      // Delete input file after processing
      await fs.unlink(inputPath).catch(() => {});
      this.logger.log(`Deleted input file: ${inputPath}`);
    } catch (err) {
      // Clean up any segment temp files on error
      for (const p of segmentPaths) {
        await fs.unlink(p).catch(() => {});
      }
      throw new InternalServerErrorException(
        `Video processing failed: ${(err as Error).message}`,
      );
    } finally {
      for (const p of segmentPaths) {
        await fs.unlink(p).catch(() => {});
      }
    }

    this.logger.log(`Processing complete: ${outputPath}`);
    return outputPath;
  }

  async cleanup(...paths: string[]): Promise<void> {
    for (const filePath of paths) {
      try {
        await fs.unlink(filePath);
        this.logger.log(`Cleaned up: ${filePath}`);
      } catch {
        this.logger.warn(`Failed to clean up: ${filePath}`);
      }
    }
  }
}
