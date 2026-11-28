const baseName = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

/** The file extension of each image type a result may be stored as. */
export const GENERATION_RESULT_EXTENSIONS: Readonly<Record<string, 'png' | 'jpg' | 'webp'>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** The names a generation stores its result under; `extension` follows the answer's image type (default PNG). */
export const generationNames = {
  edit: (sourceName: string, rank: number, extension = 'png') => `${baseName(sourceName)} edit ${rank}.${extension}`,
  upscale: (sourceName: string, scale: 2 | 4, extension = 'png') => `${baseName(sourceName)} ${scale}x.${extension}`,
};
