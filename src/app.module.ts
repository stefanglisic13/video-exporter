import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ExportModule } from './export/export.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ExportModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
