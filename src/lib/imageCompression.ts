const MAX_DIMENSION = 1800
const JPEG_QUALITY = 0.82
const MIN_SIZE_FOR_COMPRESSION = 300 * 1024

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to load image for compression.'))
    image.src = url
  })
}

function nextDimensions(width: number, height: number) {
  if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
    return { width, height }
  }

  const scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export async function compressReceiptImage(file: File): Promise<File> {
  const shouldNormalizeMime = file.type !== 'image/jpeg'
  const shouldCompress =
    file.size > MIN_SIZE_FOR_COMPRESSION || shouldNormalizeMime
  if (!shouldCompress) {
    return file
  }

  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await loadImage(objectUrl)
    const { width, height } = nextDimensions(image.naturalWidth || image.width, image.naturalHeight || image.height)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Canvas is not available for image compression.')
    }

    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) {
          resolve(result)
        } else {
          reject(new Error('Failed to compress image.'))
        }
      }, 'image/jpeg', JPEG_QUALITY)
    })

    const baseName = file.name.replace(/\.[^.]+$/, '') || 'receipt'
    const compressedFile = new File([blob], `${baseName}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    })

    return compressedFile.size < file.size ? compressedFile : file
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
