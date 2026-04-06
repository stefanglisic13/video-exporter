import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { exec } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { SegmentDto } from './dto/export-without-idle-time.dto';

const execPromise = promisify(exec);

interface CacheEntry {
  filePath: string;
  cachedAt: number;
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly tempDir: string;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly configService: ConfigService) {
    this.tempDir = this.configService.get<string>(
      'TEMP_DIR',
      '/tmp/video-exporter',
    );
    const ttlMinutes = parseInt(
      this.configService.get<string>('CACHE_TTL_MINUTES', '30'),
      10,
    );
    this.cacheTtlMs = ttlMinutes * 60 * 1000;
    this.logger.log(`Video cache TTL: ${ttlMinutes} minutes`);
  }

  async ensureTempDir(): Promise<void> {
    await fs.mkdir(this.tempDir, { recursive: true });
  }

  private getCacheKey(videoUrl: string): string {
    const pathname = new URL(videoUrl).pathname;
    return createHash('sha256').update(pathname).digest('hex').slice(0, 16);
  }

  async downloadVideo(videoUrl: string): Promise<string> {
    await this.ensureTempDir();

    const cacheKey = this.getCacheKey(videoUrl);
    const cached = this.cache.get(cacheKey);

    if (cached) {
      try {
        await fs.access(cached.filePath);
        this.logger.log(`Cache hit (${cacheKey}): ${cached.filePath}`);
        return cached.filePath;
      } catch {
        this.logger.warn(`Cache stale (file missing), re-downloading`);
        this.cache.delete(cacheKey);
      }
    }

    const inputPath = join(this.tempDir, `cache-${cacheKey}.mp4`);

    this.logger.log(`Cache miss (${cacheKey}), downloading...`);
    const dlStart = Date.now();
    try {
      await execPromise(`curl -fSL -o "${inputPath}" "${videoUrl}"`, {
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      throw new BadRequestException(
        `Failed to download video: ${(err as Error).message}`,
      );
    }

    this.cache.set(cacheKey, { filePath: inputPath, cachedAt: Date.now() });
    this.logger.log(
      `Download complete (${((Date.now() - dlStart) / 1000).toFixed(1)}s): ${inputPath}`,
    );
    return inputPath;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async evictExpiredCache(): Promise<void> {
    const now = Date.now();
    let evicted = 0;

    const keys = Array.from(this.cache.keys());
    for (const key of keys) {
      const entry = this.cache.get(key)!;
      if (now - entry.cachedAt > this.cacheTtlMs) {
        await fs.unlink(entry.filePath).catch(() => {});
        this.cache.delete(key);
        this.logger.log(`Cache evicted (${key}): ${entry.filePath}`);
        evicted++;
      }
    }

    if (evicted > 0) {
      this.logger.log(
        `Cache cleanup: evicted ${evicted}, remaining ${this.cache.size}`,
      );
    }
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

  async trimVideo(
    inputPath: string,
    trimStartMs: number,
    trimEndMs: number,
  ): Promise<string> {
    const startSec = trimStartMs / 1000;
    const durationSec = (trimEndMs - trimStartMs) / 1000;
    const outputPath = join(this.tempDir, `output-${Date.now()}.mp4`);

    this.logger.log(`trimVideo start: ${startSec}s, duration=${durationSec}s`);
    const t0 = Date.now();
    try {
      await execPromise(
        `ffmpeg -ss ${startSec} -i "${inputPath}" -t ${durationSec} -c copy -avoid_negative_ts 1 "${outputPath}"`,
      );
    } catch (err) {
      throw new InternalServerErrorException(
        `Trim failed: ${(err as Error).message}`,
      );
    }
    this.logger.log(
      `trimVideo end (${((Date.now() - t0) / 1000).toFixed(1)}s): ${outputPath}`,
    );
    await this.trimBlackStart(outputPath);
    return outputPath;
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
    const totalStart = Date.now();

    try {
      for (let i = 0; i < merged.length; i++) {
        const start = merged[i].startMs / 1000;
        const duration = (merged[i].endMs - merged[i].startMs) / 1000;
        const segPath = join(this.tempDir, `seg-${Date.now()}-${i}.mp4`);
        segmentPaths.push(segPath);

        this.logger.log(
          `ffmpeg start: segment ${i + 1}/${merged.length} (${start}s, ${duration}s)`,
        );
        const segStart = Date.now();
        await execPromise(
          `ffmpeg -ss ${start} -i "${inputPath}" -t ${duration}  -c copy -avoid_negative_ts 1 "${segPath}"`,
        );
        this.logger.log(
          `ffmpeg end: segment ${i + 1}/${merged.length} (${((Date.now() - segStart) / 1000).toFixed(1)}s)`,
        );
      }

      if (segmentPaths.length === 1) {
        await fs.rename(segmentPaths[0], outputPath);
        segmentPaths.length = 0;
      } else {
        const concatListPath = join(this.tempDir, `concat-${Date.now()}.txt`);
        const concatContent = segmentPaths.map((p) => `file '${p}'`).join('\n');
        await fs.writeFile(concatListPath, concatContent);

        this.logger.log(`ffmpeg start: concat ${segmentPaths.length} segments`);
        const concatStart = Date.now();
        await execPromise(
          `ffmpeg -f concat -safe 0 -i "${concatListPath}" -c copy "${outputPath}"`,
        );
        this.logger.log(
          `ffmpeg end: concat (${((Date.now() - concatStart) / 1000).toFixed(1)}s)`,
        );

        await fs.unlink(concatListPath).catch(() => {});
      }
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

    await this.trimBlackStart(outputPath);
    const totalSec = ((Date.now() - totalStart) / 1000).toFixed(1);
    this.logger.log(`Processing complete (${totalSec}s total): ${outputPath}`);
    return outputPath;
  }

  private async trimBlackStart(outputPath: string): Promise<string> {
    const trimmedPath = outputPath.replace('.mp4', '-trimmed.mp4');
    this.logger.log('Trimming first 0.1s from output...');
    try {
      await execPromise(
        `ffmpeg -ss 0.1 -i "${outputPath}" -c copy "${trimmedPath}"`,
      );
      await fs.unlink(outputPath).catch(() => {});
      await fs.rename(trimmedPath, outputPath);
    } catch {
      await fs.unlink(trimmedPath).catch(() => {});
      this.logger.warn('trimBlackStart failed, keeping original');
    }
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
