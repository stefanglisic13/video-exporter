import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  ValidateNested,
} from 'class-validator';
import { SegmentDto } from './export-without-idle-time.dto';

export class ExportTrimDto {
  @IsUrl()
  videoUrl: string;

  @IsNumber()
  @Min(0)
  trimStartMs: number;

  @IsNumber()
  @Min(0)
  trimEndMs: number;

  @IsBoolean()
  includeIdleTime: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SegmentDto)
  segments?: SegmentDto[];

  @IsOptional()
  @IsString()
  videoName?: string;
}
