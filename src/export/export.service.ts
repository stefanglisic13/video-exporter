import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ffmpeg from 'fluent-ffmpeg';
import { createWriteStream, promises as fs } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import { SegmentDto } from './dto/export-without-idle-time.dto';

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
    const inputPath = join(this.tempDir, `input-${uuidv4()}.mp4`);

    const response = await fetch(videoUrl);
    if (!response.ok) {
      throw new BadRequestException(
        `Failed to download video: ${response.status} ${response.statusText}`,
      );
    }

    const fileStream = createWriteStream(inputPath);
    await pipeline(response.body as any, fileStream);

    this.logger.log(`Downloaded video to ${inputPath}`);
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

  private async probeHasAudio(inputPath: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) return reject(new Error(String(err)));
        const hasAudio = metadata.streams.some((s) => s.codec_type === 'audio');
        resolve(hasAudio);
      });
    });
  }

  async processVideo(
    inputPath: string,
    segments: SegmentDto[],
  ): Promise<string> {
    const merged = this.sortAndMergeSegments(segments);
    if (merged.length === 0) {
      throw new BadRequestException('No valid segments provided');
    }

    const outputPath = join(this.tempDir, `output-${uuidv4()}.mp4`);
    const hasAudio = await this.probeHasAudio(inputPath);

    const filterParts: string[] = [];
    const concatInputs: string[] = [];

    for (let i = 0; i < merged.length; i++) {
      const startSec = merged[i].startMs / 1000;
      const endSec = merged[i].endMs / 1000;

      filterParts.push(
        `[0:v]trim=start=${startSec}:end=${endSec},setpts=PTS-STARTPTS[v${i}]`,
      );
      concatInputs.push(`[v${i}]`);

      if (hasAudio) {
        filterParts.push(
          `[0:a]atrim=start=${startSec}:end=${endSec},asetpts=PTS-STARTPTS[a${i}]`,
        );
        concatInputs.push(`[a${i}]`);
      }
    }

    const audioFlag = hasAudio ? 1 : 0;
    const concatFilter = `${concatInputs.join('')}concat=n=${merged.length}:v=1:a=${audioFlag}[outv]${hasAudio ? '[outa]' : ''}`;
    filterParts.push(concatFilter);

    const filterComplex = filterParts.join('; ');

    this.logger.log(
      `Processing ${merged.length} segments, hasAudio=${hasAudio}`,
    );

    return new Promise((resolve, reject) => {
      let cmd = ffmpeg(inputPath)
        .complexFilter(filterComplex)
        .outputOptions('-map', '[outv]');

      if (hasAudio) {
        cmd = cmd.outputOptions('-map', '[outa]');
      }

      cmd
        .outputOptions('-movflags', '+faststart')
        .output(outputPath)
        .on('start', (commandLine) => {
          this.logger.log(`ffmpeg command: ${commandLine}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            this.logger.log(`Processing: ${progress.percent.toFixed(1)}%`);
          }
        })
        .on('end', () => {
          this.logger.log(`Processing complete: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          this.logger.error(`ffmpeg error: ${err.message}`);
          reject(
            new InternalServerErrorException(
              `Video processing failed: ${err.message}`,
            ),
          );
        })
        .run();
    });
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
