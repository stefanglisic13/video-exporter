import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [ExportController],
  providers: [ExportService],
})
export class ExportModule {}
