import { Body, Controller, Logger, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { createReadStream } from 'fs';
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
    let inputPath: string | undefined;
    let outputPath: string | undefined;

    try {
      this.logger.log(
        `Export request: ${dto.segments.length} segments, url=${dto.videoUrl}`,
      );

      inputPath = await this.exportService.downloadVideo(dto.videoUrl);
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
        void this.exportService.cleanup(inputPath!, outputPath!);
      });

      fileStream.on('error', () => {
        void this.exportService.cleanup(inputPath!, outputPath!);
      });

      fileStream.pipe(res);
    } catch (error) {
      const toClean = [inputPath, outputPath].filter((p): p is string => !!p);
      if (toClean.length) {
        await this.exportService.cleanup(...toClean);
      }
      throw error;
    }
  }
}
