import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { ExportTrimDto } from './dto/export-trim.dto';
import { ExportWithoutIdleTimeDto } from './dto/export-without-idle-time.dto';
import { ExportService } from './export.service';

@Controller('export')
export class ExportController {
  private readonly logger = new Logger(ExportController.name);

  constructor(private readonly exportService: ExportService) {}

  @Post('without-idle-time')
  async exportWithoutIdleTime(
    @Body() dto: ExportWithoutIdleTimeDto,
    @Res() res: Response,
  ) {
    let outputPath: string | undefined;

    try {
      this.logger.log(
        `Export request: ${dto.segments.length} segments, url=${dto.videoUrl}`,
      );

      const inputPath = await this.exportService.downloadVideo(dto.videoUrl);
      outputPath = await this.exportService.processVideo(
        inputPath,
        dto.segments,
      );

      const fileName = dto.videoName
        ? `${dto.videoName.replace(/\.mp4$/i, '')}-no-idle.mp4`
        : 'video-no-idle.mp4';

      res.set({
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      });

      const fileStream = createReadStream(outputPath);

      fileStream.on('end', () => {
        void this.exportService.cleanup(outputPath!);
      });

      fileStream.on('error', () => {
        void this.exportService.cleanup(outputPath!);
      });

      fileStream.pipe(res);
    } catch (error) {
      if (outputPath) {
        await this.exportService.cleanup(outputPath);
      }
      throw error;
    }
  }

  @Post('trim')
  async exportTrim(@Body() dto: ExportTrimDto, @Res() res: Response) {
    let outputPath: string | undefined;

    try {
      this.logger.log(
        `Trim export: ${dto.trimStartMs}ms-${dto.trimEndMs}ms, includeIdleTime=${dto.includeIdleTime}`,
      );

      const inputPath = await this.exportService.downloadVideo(dto.videoUrl);

      if (dto.includeIdleTime) {
        outputPath = await this.exportService.trimVideo(
          inputPath,
          dto.trimStartMs,
          dto.trimEndMs,
        );
      } else {
        if (!dto.segments?.length) {
          throw new BadRequestException(
            'segments are required when includeIdleTime is false',
          );
        }

        const clamped = dto.segments
          .map((s) => ({
            startMs: Math.max(s.startMs, dto.trimStartMs),
            endMs: Math.min(s.endMs, dto.trimEndMs),
          }))
          .filter((s) => s.startMs < s.endMs);

        if (clamped.length === 0) {
          throw new BadRequestException(
            'No segments overlap with the trim range',
          );
        }

        outputPath = await this.exportService.processVideo(inputPath, clamped);
      }

      const suffix = dto.includeIdleTime ? 'trimmed' : 'no-idle';
      const fileName = dto.videoName
        ? `${dto.videoName.replace(/\.mp4$/i, '')}-${suffix}.mp4`
        : `video-${suffix}.mp4`;

      res.set({
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      });

      const fileStream = createReadStream(outputPath);

      fileStream.on('end', () => {
        void this.exportService.cleanup(outputPath!);
      });

      fileStream.on('error', () => {
        void this.exportService.cleanup(outputPath!);
      });

      fileStream.pipe(res);
    } catch (error) {
      if (outputPath) {
        await this.exportService.cleanup(outputPath);
      }
      throw error;
    }
  }
}
