import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  ValidateNested,
} from 'class-validator';

export class SegmentDto {
  @IsNumber()
  @Min(0)
  startMs: number;

  @IsNumber()
  @Min(0)
  endMs: number;
}

export class ExportWithoutIdleTimeDto {
  @IsUrl()
  videoUrl: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SegmentDto)
  segments: SegmentDto[];

  @IsOptional()
  @IsString()
  videoName?: string;
}
