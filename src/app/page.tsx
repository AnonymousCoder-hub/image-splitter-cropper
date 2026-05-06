'use client'

import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import ImageCanvas, { CropRect, SegSize as SegSizeType, ZoomMode } from '@/components/image-canvas'
import SegmentPreview from '@/components/segment-preview'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Upload,
  Crop,
  Grid3x3,
  Download,
  Trash2,
  Image as ImageIcon,
  Scissors,
  RotateCcw,
  FileArchive,
  Loader2,
  Move,
  Maximize2,
  AlignJustify,
  Plus,
  X,
  Images,
  FolderArchive,
  Ruler,
  Hash,
} from 'lucide-react'
import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import { useToast } from '@/hooks/use-toast'

const MIN_CROP = 20
/** Max pixel dimension before blocking load outright */
const MAX_DIMENSION_BLOCK = 16384
/** Max pixel dimension before warning */
const MAX_DIMENSION_WARNING = 8192
/** Max number of images allowed at once */
const MAX_IMAGE_COUNT = 500
/** Concurrency limit for loading images simultaneously */
const LOAD_CONCURRENCY = 4
/** Max estimated total memory in MB before blocking additional loads */
const MEMORY_BUDGET_MB = 2048

type HSplitMode = 'count' | 'height'

/**
 * CRITICAL FIX #1: Store only metadata — NOT HTMLImageElement.
 * Previously, the decoded bitmap (width × height × 4 bytes) was held in React
 * state forever. A single 8000×8000 image = 256 MB. 100 such images = 25.6 GB.
 * Now we only store the lightweight objectUrl + dimensions.
 * The heavy HTMLImageElement is decoded on-demand only for the selected image.
 */
interface ImageItem {
  id: string
  name: string
  /** Object URL that must be revoked on cleanup */
  objectUrl: string
  naturalWidth: number
  naturalHeight: number
  /** Estimated decoded size in MB */
  estimatedMB: number
}

/** Compute segment heights — accounts for gaps between segments */
function getSegmentHeights(
  cropHeight: number,
  mode: HSplitMode,
  segHeight: number,
  hSegs: number,
  vGap: number,
): number[] {
  if (mode === 'height' && segHeight > 0) {
    if (vGap <= 0) {
      const fullSegs = Math.floor(cropHeight / segHeight)
      const remaining = cropHeight - fullSegs * segHeight
      const heights = Array(fullSegs).fill(segHeight)
      if (remaining > 0) heights.push(remaining)
      return heights
    }
    const step = segHeight + vGap
    const heights: number[] = []
    let pos = 0
    while (pos + segHeight <= cropHeight) {
      heights.push(segHeight)
      pos += step
    }
    const remaining = cropHeight - pos
    if (remaining > 0) heights.push(remaining)
    return heights
  }
  const h = cropHeight / hSegs
  return Array(hSegs).fill(h)
}

function getHGridPcts(
  cropHeight: number,
  mode: HSplitMode,
  segHeight: number,
  hSegs: number,
  vGap: number,
): number[] {
  if (cropHeight <= 0) return []
  const heights = getSegmentHeights(cropHeight, mode, segHeight, hSegs, vGap)
  const pcts: number[] = []
  let cumulative = 0
  for (let i = 0; i < heights.length - 1; i++) {
    cumulative += heights[i]
    pcts.push((cumulative / cropHeight) * 100)
    cumulative += vGap
  }
  return pcts
}

function getHGapRegions(
  cropHeight: number,
  mode: HSplitMode,
  segHeight: number,
  hSegs: number,
  vGap: number,
): [number, number][] {
  if (cropHeight <= 0 || vGap <= 0) return []
  const heights = getSegmentHeights(cropHeight, mode, segHeight, hSegs, vGap)
  const regions: [number, number][] = []
  let cumulative = 0
  for (let i = 0; i < heights.length - 1; i++) {
    cumulative += heights[i]
    const gapStart = cumulative
    const gapEnd = cumulative + vGap
    if (gapEnd <= cropHeight) {
      regions.push([(gapStart / cropHeight) * 100, (gapEnd / cropHeight) * 100])
    }
    cumulative = gapEnd
  }
  return regions
}

function getVGapRegions(
  cropWidth: number,
  vSegs: number,
  hGap: number,
): [number, number][] {
  if (cropWidth <= 0 || hGap <= 0 || vSegs <= 1) return []
  const segW = cropWidth / vSegs
  const regions: [number, number][] = []
  for (let i = 0; i < vSegs - 1; i++) {
    const gapStart = segW * (i + 1) + hGap * i
    const gapEnd = gapStart + hGap
    if (gapEnd <= cropWidth) {
      regions.push([(gapStart / cropWidth) * 100, (gapEnd / cropWidth) * 100])
    }
  }
  return regions
}

function getHSegCount(
  cropHeight: number,
  mode: HSplitMode,
  segHeight: number,
  hSegs: number,
  vGap: number,
): number {
  if (mode === 'height' && segHeight > 0) {
    return getSegmentHeights(cropHeight, mode, segHeight, hSegs, vGap).length
  }
  return hSegs
}

/** Helper: draw a segment onto a canvas using a reusable canvas + context */
function drawSegment(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  sx: number, sy: number, sw: number, sh: number,
  dw: number, dh: number,
) {
  canvas.width = Math.max(1, Math.round(dw))
  canvas.height = Math.max(1, Math.round(dh))
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, Math.round(sx), Math.round(sy), Math.round(sw), Math.round(sh), 0, 0, canvas.width, canvas.height)
}

/**
 * Decode an image from an object URL on-demand.
 * Returns the HTMLImageElement once loaded.
 * IMPORTANT: The caller is responsible for releasing the decoded bitmap
 * by nulling the reference when done (allowing GC).
 */
function decodeImage(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to decode image'))
    img.src = objectUrl
  })
}

export default function Home() {
  const [images, setImages] = useState<ImageItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  /**
   * CRITICAL FIX #1 continued: Only the selected image's HTMLImageElement
   * is kept decoded. When selection changes, the previous one is released.
   */
  const [decodedSelectedImg, setDecodedSelectedImg] = useState<HTMLImageElement | null>(null)
  const [isLoadingSelected, setIsLoadingSelected] = useState(false)

  const [cropRect, setCropRect] = useState<CropRect>({ x: 0, y: 0, width: 0, height: 0 })
  const [hSplitMode, setHSplitMode] = useState<HSplitMode>('count')
  const [segmentHeight, setSegmentHeight] = useState(200)
  const [horizontalSegments, setHorizontalSegments] = useState(1)
  const [verticalSegments, setVerticalSegments] = useState(1)
  const [segGap, setSegGap] = useState<SegSizeType>({ width: 0, height: 0 })
  const [showGrid, setShowGrid] = useState(true)
  const [showSegments, setShowSegments] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number; name: string } | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width')
  const [zoomPercent, setZoomPercent] = useState(100)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()

  // Track object URLs for cleanup — ref so we never lose track across renders
  const objectUrlsRef = useRef<Map<string, string>>(new Map())

  const selectedItem = images.find((item) => item.id === selectedId) || null

  // ─── Decode selected image on demand ────────────────────────────────
  // When selectedId changes, decode the image and release the previous one.
  useEffect(() => {
    if (!selectedId) {
      setDecodedSelectedImg(null)
      return
    }

    const item = images.find((i) => i.id === selectedId)
    if (!item) {
      setDecodedSelectedImg(null)
      return
    }

    let cancelled = false
    setIsLoadingSelected(true)
    setDecodedSelectedImg(null)

    decodeImage(item.objectUrl).then((img) => {
      if (!cancelled) {
        setDecodedSelectedImg(img)
        setIsLoadingSelected(false)
      } else {
        // If cancelled, we don't set state — image can be GC'd
      }
    }).catch(() => {
      if (!cancelled) {
        setIsLoadingSelected(false)
        toast({ title: 'Failed to decode', description: item.name, variant: 'destructive' })
      }
    })

    return () => { cancelled = true }
  }, [selectedId, images, toast])

  const effectiveHSegs = useMemo(
    () => getHSegCount(cropRect.height, hSplitMode, segmentHeight, horizontalSegments, segGap.height),
    [cropRect.height, hSplitMode, segmentHeight, horizontalSegments, segGap.height],
  )

  const hGridPcts = useMemo(
    () => getHGridPcts(cropRect.height, hSplitMode, segmentHeight, horizontalSegments, segGap.height),
    [cropRect.height, hSplitMode, segmentHeight, horizontalSegments, segGap.height],
  )

  const hGapRegions = useMemo(
    () => getHGapRegions(cropRect.height, hSplitMode, segmentHeight, horizontalSegments, segGap.height),
    [cropRect.height, hSplitMode, segmentHeight, horizontalSegments, segGap.height],
  )

  const vGapRegions = useMemo(
    () => getVGapRegions(cropRect.width, verticalSegments, segGap.width),
    [cropRect.width, verticalSegments, segGap.width],
  )

  const totalSegments = effectiveHSegs * verticalSegments

  /** Estimate total memory usage of all loaded images */
  const totalEstimatedMB = useMemo(
    () => images.reduce((sum, i) => sum + i.estimatedMB, 0),
    [images],
  )

  // ─── Load images from files ─────────────────────────────────────────
  const loadImages = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files).filter((f) => f.type.startsWith('image/'))
      if (fileArray.length === 0) return

      // MEMORY GUARD: Check total count
      if (images.length + fileArray.length > MAX_IMAGE_COUNT) {
        toast({
          title: 'Too many images',
          description: `Maximum ${MAX_IMAGE_COUNT} images. You have ${images.length} and tried to add ${fileArray.length}.`,
          variant: 'destructive',
        })
        return
      }

      let loadedCount = 0
      let skippedCount = 0

      /**
       * CRITICAL FIX #4: Proper sequential batch loading.
       * Previously processBatch(0) only loaded the first LOAD_CONCURRENCY
       * files and never chained to the rest. Now we properly chain batches.
       */
      const processBatch = (startIndex: number) => {
        const endIndex = Math.min(startIndex + LOAD_CONCURRENCY, fileArray.length)

        const loadOne = (index: number): Promise<void> => {
          const file = fileArray[index]
          const objectUrl = URL.createObjectURL(file)

          return decodeImage(objectUrl).then((img) => {
            // MEMORY GUARD: Block insanely large images
            if (img.naturalWidth > MAX_DIMENSION_BLOCK || img.naturalHeight > MAX_DIMENSION_BLOCK) {
              URL.revokeObjectURL(objectUrl)
              skippedCount++
              toast({
                title: 'Image too large — skipped',
                description: `${file.name}: ${img.naturalWidth}×${img.naturalHeight} exceeds ${MAX_DIMENSION_BLOCK}px limit`,
                variant: 'destructive',
              })
              return
            }

            const estimatedMB = (img.naturalWidth * img.naturalHeight * 4) / (1024 * 1024)

            // MEMORY GUARD: Check total memory budget
            const currentTotal = images.reduce((s, i) => s + i.estimatedMB, 0) +
              estimatedMB * (fileArray.length - index) // rough estimate of what's coming

            if (currentTotal > MEMORY_BUDGET_MB) {
              URL.revokeObjectURL(objectUrl)
              skippedCount++
              toast({
                title: 'Memory budget exceeded — skipped',
                description: `${file.name} (~${estimatedMB.toFixed(0)} MB) would exceed ${MEMORY_BUDGET_MB} MB total budget`,
                variant: 'destructive',
              })
              return
            }

            const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            const name = file.name.replace(/\.[^.]+$/, '')

            // Track the object URL for later cleanup
            objectUrlsRef.current.set(id, objectUrl)

            // CRITICAL FIX #1: Store metadata only, NOT the HTMLImageElement
            setImages((prev) => {
              const updated = [...prev, { id, name, objectUrl, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, estimatedMB }]
              if (prev.length === 0) {
                setSelectedId(id)
                setCropRect({ x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight })
                const ratio = img.naturalWidth / img.naturalHeight
                setZoomMode(ratio < 0.5 ? 'fit-width' : 'fit-all')
              }
              return updated
            })

            // Release the decoded bitmap — we only needed dimensions
            // The selected image will be re-decoded on demand via the useEffect above

            // Warn about large images
            if (img.naturalWidth > MAX_DIMENSION_WARNING || img.naturalHeight > MAX_DIMENSION_WARNING) {
              toast({
                title: 'Large image loaded',
                description: `${name}: ${img.naturalWidth}×${img.naturalHeight} (~${estimatedMB.toFixed(0)} MB)`,
                variant: 'destructive',
              })
            }

            loadedCount++
          }).catch(() => {
            URL.revokeObjectURL(objectUrl)
            skippedCount++
            toast({ title: 'Failed to load', description: file.name, variant: 'destructive' })
          })
        }

        // Load batch concurrently, then chain to next batch
        const batchPromises: Promise<void>[] = []
        for (let i = startIndex; i < endIndex; i++) {
          batchPromises.push(loadOne(i))
        }

        Promise.all(batchPromises).then(() => {
          if (endIndex < fileArray.length) {
            // Chain to next batch
            processBatch(endIndex)
          } else {
            // All done
            const total = loadedCount + skippedCount
            if (loadedCount > 0) {
              toast({
                title: 'Images loaded',
                description: `${loadedCount} image${loadedCount > 1 ? 's' : ''} added${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}`,
              })
            }
          }
        })
      }

      processBatch(0)
    },
    [images, toast],
  )

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      loadImages(e.target.files)
      e.target.value = ''
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      loadImages(e.dataTransfer.files)
    }
  }

  // Handle clipboard paste
  React.useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      if (files.length > 0) {
        loadImages(files as unknown as FileList)
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [loadImages])

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const item = prev.find((i) => i.id === id)
      if (item) {
        URL.revokeObjectURL(item.objectUrl)
        objectUrlsRef.current.delete(id)
      }

      const updated = prev.filter((i) => i.id !== id)
      if (id === selectedId) {
        if (updated.length > 0) {
          setSelectedId(updated[0].id)
          setCropRect({ x: 0, y: 0, width: updated[0].naturalWidth, height: updated[0].naturalHeight })
        } else {
          setSelectedId(null)
          setCropRect({ x: 0, y: 0, width: 0, height: 0 })
        }
      }
      return updated
    })
  }, [selectedId])

  const removeAllImages = useCallback(() => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    objectUrlsRef.current.clear()
    setImages([])
    setSelectedId(null)
    setDecodedSelectedImg(null)
    setCropRect({ x: 0, y: 0, width: 0, height: 0 })
    setShowSegments(false)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      objectUrlsRef.current.clear()
    }
  }, [])

  const resetCrop = () => {
    if (selectedItem) {
      setCropRect({ x: 0, y: 0, width: selectedItem.naturalWidth, height: selectedItem.naturalHeight })
    }
  }

  const selectImage = (id: string) => {
    const item = images.find((i) => i.id === id)
    if (item) {
      setSelectedId(id)
      setCropRect({ x: 0, y: 0, width: item.naturalWidth, height: item.naturalHeight })
      const ratio = item.naturalWidth / item.naturalHeight
      setZoomMode(ratio < 0.5 ? 'fit-width' : 'fit-all')
    }
  }

  const clampCrop = (crop: CropRect, w: number, h: number): CropRect => ({
    x: Math.max(0, Math.min(crop.x, w - MIN_CROP)),
    y: Math.max(0, Math.min(crop.y, h - MIN_CROP)),
    width: Math.max(MIN_CROP, Math.min(crop.width, w)),
    height: Math.max(MIN_CROP, Math.min(crop.height, h)),
  })

  // ─── Batch export all images ────────────────────────────────────────
  // CRITICAL FIX #7: Decode one image at a time, process, then release.
  // This means only ONE decoded bitmap in memory at a time during export.
  const exportAllImages = async () => {
    if (images.length === 0) return
    setIsExporting(true)

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!

    try {
      const zip = new JSZip()
      let totalFiles = 0

      for (let idx = 0; idx < images.length; idx++) {
        const item = images[idx]
        setExportProgress({ current: idx + 1, total: images.length, name: item.name })

        // Decode on demand, release after processing this image
        const img = await decodeImage(item.objectUrl)
        const cr = clampCrop(cropRect, item.naturalWidth, item.naturalHeight)
        const folder = zip.folder(item.name)!
        const segHeights = getSegmentHeights(cr.height, hSplitMode, segmentHeight, horizontalSegments, segGap.height)
        const segWidth = cr.width / verticalSegments

        let yPos = 0
        for (let h = 0; h < segHeights.length; h++) {
          const sh = segHeights[h]
          for (let v = 0; v < verticalSegments; v++) {
            drawSegment(canvas, ctx, img,
              cr.x + (segWidth + segGap.width) * v, cr.y + yPos, segWidth, sh,
              segWidth, sh,
            )

            const blob = await new Promise<Blob>((resolve) => {
              canvas.toBlob((b) => resolve(b!), 'image/png')
            })

            const paddedRow = String(h + 1).padStart(String(segHeights.length).length, '0')
            const paddedCol = String(v + 1).padStart(String(verticalSegments).length, '0')
            folder.file(`R${paddedRow}_C${paddedCol}.png`, blob)
            totalFiles++
          }
          yPos += sh + (h < segHeights.length - 1 ? segGap.height : 0)
        }

        // Release the decoded bitmap for this image
        img.src = ''
        // Yield to UI every image
        await new Promise((r) => setTimeout(r, 0))
      }

      // CRITICAL FIX #7: Use streaming generation for large ZIPs
      const content = await zip.generateAsync(
        { type: 'blob', streamFiles: true },
        (metadata) => {
          // Optional: could show zip generation progress
        },
      )
      saveAs(content, `batch_segments_${images.length}images.zip`)

      toast({
        title: 'Batch export complete',
        description: `${images.length} image${images.length > 1 ? 's' : ''} → ${totalFiles} segment files`,
      })
    } catch {
      toast({ title: 'Export failed', description: 'An error occurred during batch export', variant: 'destructive' })
    } finally {
      canvas.width = 1
      canvas.height = 1
      setIsExporting(false)
      setExportProgress(null)
    }
  }

  // ─── Export selected image segments ─────────────────────────────────
  const exportSelectedSegments = async () => {
    if (!selectedItem) return
    setIsExporting(true)

    // Decode on demand
    const img = decodedSelectedImg || await decodeImage(selectedItem.objectUrl)

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!

    try {
      const zip = new JSZip()
      const cr = clampCrop(cropRect, selectedItem.naturalWidth, selectedItem.naturalHeight)
      const segHeights = getSegmentHeights(cr.height, hSplitMode, segmentHeight, horizontalSegments, segGap.height)
      const segWidth = cr.width / verticalSegments

      let yPos = 0
      for (let h = 0; h < segHeights.length; h++) {
        const sh = segHeights[h]
        for (let v = 0; v < verticalSegments; v++) {
          drawSegment(canvas, ctx, img,
            cr.x + (segWidth + segGap.width) * v, cr.y + yPos, segWidth, sh,
            segWidth, sh,
          )

          const blob = await new Promise<Blob>((resolve) => {
            canvas.toBlob((b) => resolve(b!), 'image/png')
          })

          const paddedRow = String(h + 1).padStart(String(segHeights.length).length, '0')
          const paddedCol = String(v + 1).padStart(String(verticalSegments).length, '0')
          zip.file(`${selectedItem.name}_R${paddedRow}_C${paddedCol}.png`, blob)
        }
        yPos += sh + (h < segHeights.length - 1 ? segGap.height : 0)
      }

      const content = await zip.generateAsync({ type: 'blob', streamFiles: true })
      saveAs(content, `${selectedItem.name}_segments.zip`)

      toast({
        title: 'Export complete',
        description: `${segHeights.length * verticalSegments} segments exported`,
      })
    } catch {
      toast({ title: 'Export failed', description: 'An error occurred', variant: 'destructive' })
    } finally {
      canvas.width = 1
      canvas.height = 1
      setIsExporting(false)
    }
  }

  // ─── Export single cropped image ────────────────────────────────────
  const exportCropped = async () => {
    if (!selectedItem) return
    setIsExporting(true)

    try {
      const img = decodedSelectedImg || await decodeImage(selectedItem.objectUrl)
      const cr = clampCrop(cropRect, selectedItem.naturalWidth, selectedItem.naturalHeight)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(cr.width)
      canvas.height = Math.round(cr.height)
      const ctx = canvas.getContext('2d')!

      ctx.drawImage(img, Math.round(cr.x), Math.round(cr.y), Math.round(cr.width), Math.round(cr.height), 0, 0, canvas.width, canvas.height)

      canvas.toBlob((blob) => {
        if (blob) saveAs(blob, `${selectedItem.name}_cropped.png`)
      }, 'image/png')

      toast({ title: 'Export complete', description: 'Cropped image exported as PNG' })
    } catch {
      toast({ title: 'Export failed', description: 'An error occurred', variant: 'destructive' })
    } finally {
      setIsExporting(false)
    }
  }

  const lastSegInfo = useMemo(() => {
    if (hSplitMode !== 'height' || segmentHeight <= 0 || cropRect.height <= 0) return null
    const fullSegs = Math.floor(cropRect.height / segmentHeight)
    const remaining = cropRect.height - fullSegs * segmentHeight
    if (remaining <= 0) return null
    return { fullSegs, remainingHeight: remaining }
  }, [hSplitMode, segmentHeight, cropRect.height])

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary text-primary-foreground">
              <Scissors className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Image Splitter & Cropper</h1>
              <p className="text-xs text-muted-foreground hidden sm:block">
                Crop precisely · Split by count or height · Batch export
              </p>
            </div>
          </div>
          {selectedItem && (
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs font-mono">
                {selectedItem.naturalWidth} × {selectedItem.naturalHeight}
              </Badge>
              <Badge variant="outline" className="text-xs">
                {images.length} image{images.length !== 1 ? 's' : ''}
              </Badge>
              {totalSegments > 1 && (
                <Badge variant="outline" className="text-xs">
                  {effectiveHSegs}H × {verticalSegments}V
                </Badge>
              )}
              <Badge variant="outline" className="text-xs">
                {totalEstimatedMB.toFixed(0)} MB
              </Badge>
            </div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-[1600px] mx-auto w-full px-4 sm:px-6 py-4 sm:py-6">
        {images.length === 0 ? (
          /* Upload Zone */
          <div className="flex items-center justify-center min-h-[calc(100vh-12rem)]">
            <div
              className={`w-full max-w-2xl border-2 border-dashed rounded-2xl p-12 sm:p-16 text-center transition-all duration-200 cursor-pointer ${
                isDragOver
                  ? 'border-primary bg-primary/5 scale-[1.02]'
                  : 'border-border hover:border-primary/50 hover:bg-muted/30'
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="flex flex-col items-center gap-4">
                <div
                  className={`w-20 h-20 rounded-2xl flex items-center justify-center transition-colors ${
                    isDragOver ? 'bg-primary/10' : 'bg-muted'
                  }`}
                >
                  <Upload
                    className={`w-10 h-10 transition-colors ${isDragOver ? 'text-primary' : 'text-muted-foreground'}`}
                  />
                </div>
                <div>
                  <p className="text-xl font-medium">Drop your images here</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    or click to browse · Ctrl+V to paste · Up to {MAX_IMAGE_COUNT} images
                  </p>
                </div>
                <Button size="lg" className="mt-2">
                  <Images className="w-4 h-4 mr-2" />
                  Choose Images
                </Button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileChange}
                className="hidden"
              />
            </div>
          </div>
        ) : (
          /* Editor Layout */
          <div className="flex flex-col lg:flex-row gap-4 sm:gap-6">
            {/* Canvas Area */}
            <div className="flex-1 min-w-0">
              {/* Thumbnail strip */}
              <div className="flex items-center gap-2 mb-3 overflow-x-auto pb-2 custom-scrollbar">
                {images.map((item) => (
                  <div
                    key={item.id}
                    className={`flex-shrink-0 relative group rounded-lg overflow-hidden border-2 cursor-pointer transition-all ${
                      item.id === selectedId
                        ? 'border-primary shadow-sm shadow-primary/20'
                        : 'border-border hover:border-primary/40'
                    }`}
                    style={{ width: 56, height: 56 }}
                    onClick={() => selectImage(item.id)}
                  >
                    <img
                      src={item.objectUrl}
                      alt={item.name}
                      className="w-full h-full object-cover"
                      draggable={false}
                      loading="lazy"
                    />
                    <button
                      className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-destructive/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeImage(item.id)
                      }}
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                    {item.id === selectedId && (
                      <div className="absolute bottom-0 left-0 right-0 bg-primary/80 text-primary-foreground text-[8px] text-center py-0.5 truncate px-1">
                        {item.name}
                      </div>
                    )}
                  </div>
                ))}
                <div
                  className="flex-shrink-0 w-14 h-14 rounded-lg border-2 border-dashed border-border flex items-center justify-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Plus className="w-5 h-5 text-muted-foreground" />
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleFileChange}
                  className="hidden"
                />
              </div>

              {/* Zoom toolbar */}
              <div className="flex items-center gap-2 mb-2">
                <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
                  <Button
                    variant={zoomMode === 'fit-width' ? 'default' : 'ghost'}
                    size="sm"
                    className="h-7 text-xs px-2.5"
                    onClick={() => setZoomMode('fit-width')}
                  >
                    <AlignJustify className="w-3.5 h-3.5 mr-1.5" />
                    Fit Width
                  </Button>
                  <Button
                    variant={zoomMode === 'fit-all' ? 'default' : 'ghost'}
                    size="sm"
                    className="h-7 text-xs px-2.5"
                    onClick={() => setZoomMode('fit-all')}
                  >
                    <Maximize2 className="w-3.5 h-3.5 mr-1.5" />
                    Fit All
                  </Button>
                </div>
                <span className="text-xs text-muted-foreground ml-1">
                  Ctrl+Scroll to zoom · Scroll to pan
                </span>
                <Badge variant="outline" className="text-xs font-mono ml-auto">
                  {zoomPercent}%
                </Badge>
              </div>

              {/* Canvas */}
              <div className="h-[50vh] sm:h-[60vh] lg:h-[calc(100vh-16rem)]">
                {isLoadingSelected && (
                  <div className="w-full h-full flex items-center justify-center bg-[#0f0f0f] rounded-lg border border-border">
                    <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                  </div>
                )}
                {!isLoadingSelected && decodedSelectedImg && selectedItem && (
                  <ImageCanvas
                    image={decodedSelectedImg}
                    cropRect={cropRect}
                    onCropChange={setCropRect}
                    horizontalSegments={effectiveHSegs}
                    verticalSegments={verticalSegments}
                    customHGridPcts={hSplitMode === 'height' ? hGridPcts : undefined}
                    hGapRegions={hSplitMode === 'height' ? hGapRegions : undefined}
                    vGapRegions={vGapRegions.length > 0 ? vGapRegions : undefined}
                    showSegBox={hSplitMode === 'height'}
                    segSize={{ width: Math.round(cropRect.width / verticalSegments), height: segmentHeight }}
                    onSegSizeChange={(s) => {
                      setSegmentHeight(Math.max(1, s.height))
                      if (s.width > 0) {
                        const newVSegs = Math.max(1, Math.round(cropRect.width / s.width))
                        setVerticalSegments(newVSegs)
                      }
                    }}
                    segGap={segGap}
                    onSegGapChange={setSegGap}
                    showGrid={showGrid}
                    zoomMode={zoomMode}
                    onZoomPercentChange={setZoomPercent}
                  />
                )}
              </div>
            </div>

            {/* Controls Sidebar */}
            <div className="w-full lg:w-80 xl:w-96 flex-shrink-0 space-y-4">
              {/* Image Info */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <ImageIcon className="w-4 h-4" />
                    Images
                    <Badge variant="secondary" className="text-xs ml-auto">
                      {images.length}
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      {totalEstimatedMB.toFixed(0)} MB
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={() => fileInputRef.current?.click()}>
                      <Plus className="w-3 h-3 mr-1" />
                      Add More
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1 text-xs text-destructive hover:text-destructive" onClick={removeAllImages}>
                      <Trash2 className="w-3 h-3 mr-1" />
                      Clear All
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Crop Info */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Crop className="w-4 h-4" />
                    Crop Region
                    {selectedItem && (
                      <span className="text-[10px] text-muted-foreground ml-auto font-mono">
                        {selectedItem.name}
                      </span>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs text-muted-foreground">X</Label>
                      <Input
                        type="number"
                        value={Math.round(cropRect.x)}
                        onChange={(e) => {
                          const val = Number(e.target.value)
                          if (selectedItem)
                            setCropRect((r) => ({ ...r, x: Math.max(0, Math.min(selectedItem.naturalWidth - r.width, val)) }))
                        }}
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Y</Label>
                      <Input
                        type="number"
                        value={Math.round(cropRect.y)}
                        onChange={(e) => {
                          const val = Number(e.target.value)
                          if (selectedItem)
                            setCropRect((r) => ({ ...r, y: Math.max(0, Math.min(selectedItem.naturalHeight - r.height, val)) }))
                        }}
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Width</Label>
                      <Input
                        type="number"
                        value={Math.round(cropRect.width)}
                        onChange={(e) => {
                          const val = Number(e.target.value)
                          if (selectedItem)
                            setCropRect((r) => ({ ...r, width: Math.max(MIN_CROP, Math.min(selectedItem.naturalWidth - r.x, val)) }))
                        }}
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Height</Label>
                      <Input
                        type="number"
                        value={Math.round(cropRect.height)}
                        onChange={(e) => {
                          const val = Number(e.target.value)
                          if (selectedItem)
                            setCropRect((r) => ({ ...r, height: Math.max(MIN_CROP, Math.min(selectedItem.naturalHeight - r.y, val)) }))
                        }}
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={resetCrop}>
                      <RotateCcw className="w-3 h-3 mr-1" />
                      Reset
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs"
                      onClick={() => {
                        if (!selectedItem) return
                        const margin = 0.1
                        setCropRect({
                          x: Math.round(selectedItem.naturalWidth * margin),
                          y: Math.round(selectedItem.naturalHeight * margin),
                          width: Math.round(selectedItem.naturalWidth * (1 - 2 * margin)),
                          height: Math.round(selectedItem.naturalHeight * (1 - 2 * margin)),
                        })
                      }}
                    >
                      <Move className="w-3 h-3 mr-1" />
                      Center
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Split Settings */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Grid3x3 className="w-4 h-4" />
                    Split Settings
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5 block">Horizontal Split Mode</Label>
                    <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
                      <Button
                        variant={hSplitMode === 'count' ? 'default' : 'ghost'}
                        size="sm"
                        className="h-7 text-xs px-2.5 flex-1"
                        onClick={() => setHSplitMode('count')}
                      >
                        <Hash className="w-3 h-3 mr-1" />
                        By Count
                      </Button>
                      <Button
                        variant={hSplitMode === 'height' ? 'default' : 'ghost'}
                        size="sm"
                        className="h-7 text-xs px-2.5 flex-1"
                        onClick={() => setHSplitMode('height')}
                      >
                        <Ruler className="w-3 h-3 mr-1" />
                        By Height
                      </Button>
                    </div>
                  </div>

                  {hSplitMode === 'count' && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <Label className="text-xs text-muted-foreground">Horizontal Rows</Label>
                        <span className="text-xs font-mono font-medium bg-muted px-1.5 py-0.5 rounded">
                          {horizontalSegments}
                        </span>
                      </div>
                      <Input
                        type="number"
                        min={1}
                        max={200}
                        value={horizontalSegments}
                        onChange={(e) =>
                          setHorizontalSegments(Math.max(1, Math.min(200, Number(e.target.value) || 1)))
                        }
                        className="h-8 text-sm"
                      />
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Split into {horizontalSegments} equal horizontal strip{horizontalSegments > 1 ? 's' : ''}
                      </p>
                    </div>
                  )}

                  {hSplitMode === 'height' && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <Label className="text-xs text-muted-foreground">Segment Height (px)</Label>
                        <span className="text-xs font-mono font-medium bg-muted px-1.5 py-0.5 rounded">
                          {segmentHeight}px
                        </span>
                      </div>
                      <Input
                        type="number"
                        min={1}
                        max={100000}
                        value={segmentHeight}
                        onChange={(e) =>
                          setSegmentHeight(Math.max(1, Number(e.target.value) || 1))
                        }
                        className="h-8 text-sm"
                      />
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {cropRect.height > 0 && segmentHeight > 0 ? (
                          <>
                            {Math.floor(cropRect.height / segmentHeight)} full segment{Math.floor(cropRect.height / segmentHeight) !== 1 ? 's' : ''} of {segmentHeight}px
                            {lastSegInfo && (
                              <span className="text-amber-500"> + 1 remaining segment of {Math.round(lastSegInfo.remainingHeight)}px</span>
                            )}
                            {' '}= {effectiveHSegs} total rows
                          </>
                        ) : (
                          'Drag the amber box on the image to set segment size'
                        )}
                      </p>
                    </div>
                  )}

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <Label className="text-xs text-muted-foreground">Vertical Columns</Label>
                      <span className="text-xs font-mono font-medium bg-muted px-1.5 py-0.5 rounded">
                        {verticalSegments}
                      </span>
                    </div>
                    <Input
                      type="number"
                      min={1}
                      max={200}
                      value={verticalSegments}
                      onChange={(e) =>
                        setVerticalSegments(Math.max(1, Math.min(200, Number(e.target.value) || 1)))
                      }
                      className="h-8 text-sm"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Each row splits into {verticalSegments} equal column{verticalSegments > 1 ? 's' : ''}
                    </p>
                  </div>

                  <Separator />

                  <div>
                    <Label className="text-xs text-muted-foreground mb-1.5 block">Gap Between Segments</Label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Horizontal Gap</Label>
                        <Input
                          type="number"
                          min={0}
                          max={10000}
                          value={segGap.width}
                          onChange={(e) => setSegGap((g) => ({ ...g, width: Math.max(0, Number(e.target.value) || 0) }))}
                          className="h-8 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Vertical Gap</Label>
                        <Input
                          type="number"
                          min={0}
                          max={10000}
                          value={segGap.height}
                          onChange={(e) => setSegGap((g) => ({ ...g, height: Math.max(0, Number(e.target.value) || 0) }))}
                          className="h-8 text-xs font-mono"
                        />
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Pixels skipped between segments. Drag the red box on the image to set visually.
                    </p>
                  </div>

                  <Separator />

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Show grid overlay</Label>
                      <Switch checked={showGrid} onCheckedChange={setShowGrid} />
                    </div>
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Show segment preview</Label>
                      <Switch checked={showSegments} onCheckedChange={setShowSegments} />
                    </div>
                  </div>

                  {totalSegments > 1 && (
                    <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Rows per image</span>
                        <span className="font-medium">{effectiveHSegs}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Segments per image</span>
                        <span className="font-medium">{totalSegments}</span>
                      </div>
                      {hSplitMode === 'height' && (
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Segment size</span>
                          <span className="font-mono">
                            {Math.round(cropRect.width / verticalSegments)} × {segmentHeight}px
                            {lastSegInfo && <span className="text-amber-500"> (+{Math.round(lastSegInfo.remainingHeight)}px)</span>}
                          </span>
                        </div>
                      )}
                      {hSplitMode === 'count' && (
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Segment size</span>
                          <span className="font-mono">
                            {Math.round(cropRect.width / verticalSegments)} × {Math.round(cropRect.height / horizontalSegments)}
                          </span>
                        </div>
                      )}
                      {images.length > 1 && (
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Total files (all images)</span>
                          <span className="font-medium">
                            {hSplitMode === 'height'
                              ? `${effectiveHSegs * verticalSegments}+ per image`
                              : totalSegments * images.length}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Export */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Download className="w-4 h-4" />
                    Export
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {images.length > 1 && (
                    <Button className="w-full" onClick={exportAllImages} disabled={isExporting}>
                      {isExporting && exportProgress ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <FolderArchive className="w-4 h-4 mr-2" />
                      )}
                      {isExporting && exportProgress
                        ? `Processing ${exportProgress.name} (${exportProgress.current}/${exportProgress.total})...`
                        : `Export All ${images.length} Images (ZIP)`}
                    </Button>
                  )}

                  <Button
                    variant={images.length > 1 ? 'outline' : 'default'}
                    className="w-full"
                    onClick={exportSelectedSegments}
                    disabled={isExporting}
                  >
                    {isExporting && !exportProgress ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <FileArchive className="w-4 h-4 mr-2" />
                    )}
                    {isExporting && !exportProgress
                      ? 'Exporting...'
                      : `Export ${totalSegments} Segment${totalSegments !== 1 ? 's' : ''} (ZIP)`}
                  </Button>

                  <Button variant="outline" className="w-full" onClick={exportCropped} disabled={isExporting}>
                    <Download className="w-4 h-4 mr-2" />
                    Export Cropped Image (PNG)
                  </Button>

                  {isExporting && exportProgress && (
                    <div className="space-y-1">
                      <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-primary h-full rounded-full transition-all duration-300"
                          style={{ width: `${(exportProgress.current / exportProgress.total) * 100}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground text-center">
                        Processing {exportProgress.current} of {exportProgress.total}: {exportProgress.name}
                      </p>
                    </div>
                  )}

                  <Separator className="my-2" />
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={() => fileInputRef.current?.click()}>
                      <Plus className="w-3 h-3 mr-1" />
                      Add Images
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1 text-xs text-destructive hover:text-destructive" onClick={removeAllImages}>
                      <Trash2 className="w-3 h-3 mr-1" />
                      Remove All
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Segment Preview */}
              {showSegments && decodedSelectedImg && selectedItem && (
                <Card>
                  <CardContent className="pt-4">
                    <SegmentPreview
                      image={decodedSelectedImg}
                      cropRect={cropRect}
                      horizontalSegments={effectiveHSegs}
                      verticalSegments={verticalSegments}
                    />
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border bg-background mt-auto">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>Image Splitter & Cropper</span>
          <span>Memory-optimized · Split by count or pixel height · Batch process</span>
        </div>
      </footer>
    </div>
  )
}
