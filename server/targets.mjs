import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import {applyCrop} from '@8thwall/image-target-cli/src/apply.js';

export async function buildImageTarget(inputFile, outputDir, publicImagePath, name) {
  await fs.mkdir(outputDir, {recursive: true});
  const source = sharp(inputFile, {limitInputPixels: 50_000_000})
    .rotate().flatten({background: '#ffffff'});
  const normalized = await source.resize({width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true}).png().toBuffer();
  let {width, height} = await sharp(normalized).metadata();
  if (width < 240 || height < 240) throw new Error('Фото слишком маленькое. Нужно минимум 240 пикселей по каждой стороне.');
  if (width / height > 3 || height / width > 3) throw new Error('Панорамные фотографии не подходят как маркер.');
  const factor = Math.max(1, 480 / width, 640 / height);
  width = Math.ceil(width * factor); height = Math.ceil(height * factor);
  const image = sharp(await sharp(normalized).resize(width, height).png().toBuffer());
  await applyCrop(image, {
    type: 'PLANAR',
    geometry: {left: 0, top: 0, width, height, originalWidth: width, originalHeight: height, isRotated: false},
  }, outputDir, 'marker', false);
  const metadata = JSON.parse(await fs.readFile(path.join(outputDir, 'marker.json'), 'utf8'));
  metadata.name = name || metadata.name || 'marker';
  metadata.imagePath = publicImagePath;
  await fs.writeFile(path.join(outputDir, 'marker.json'), JSON.stringify(metadata, null, 2));
  return {width, height, aspect: width / height, metadata};
}

