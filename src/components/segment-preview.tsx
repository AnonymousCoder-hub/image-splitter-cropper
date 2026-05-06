'use client'

import React, { useMemo, useEffect, useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { CropRect } from './image-canvas'

interface SegmentPreviewProps {
  image: HTMLImageElement
  cropRect: CropRect
  horizontalSegments: number
  verticalSegments: number
}

interface SegPreviewItem {
  id: string
  row: number
  col: number
  objectUrl: string
  sw: number
  sh: number
}

/**
 * CRITICAL FIX #2 & #3 & #6: Complete rewrite of SegmentPreview.
 *
 * Previous bugs:
 * - Blob URLs never revoked on parameter change (cleanup only on unmount)
 * - canvas.toBlob race condition — stale callbacks leaked blob URLs
 * - Full-resolution PNG blobs created for tiny preview thumbnails
 *
 * Fixes:
 * - Generation counter to cancel stale toBlob operations
 * - Proper blob URL revocation on every re-render
 * - Thumbnail-sized canvas (max 200px) instead of full-resolution
 * - Deduplication via ref to prevent duplicate URL tracking
 */
export default function SegmentPreview({
  image,
  cropRect,
  horizontalSegments,
  verticalSegments,
}: SegmentPreviewProps) {
  const [segments, setSegments] = useState<SegPreviewItem[]>([])
  const prevUrlsRef = useRef<string[]>([])

  // CRITICAL FIX #3: Generation counter to invalidate stale async operations
  const generationRef = useRef(0)

  // Revoke ALL previous object URLs — called before creating new ones
  // AND on unmount
  const revokeAllUrls = useRef(() => {
    prevUrlsRef.current.forEach(url => {
      try { URL.revokeObjectURL(url) } catch {}
    })
    prevUrlsRef.current = []
  })

  // Cleanup on unmount
  useEffect(() => {
    return () => { revokeAllUrls.current() }
  }, [])

  // Generate segment previews using blob URLs
  useEffect(() => {
    // Increment generation to invalidate any in-flight toBlob callbacks
    const currentGen = ++generationRef.current

    // CRITICAL FIX #2: Revoke old URLs immediately on every re-render
    revokeAllUrls.current()

    if (!horizontalSegments || !verticalSegments) {
      setSegments([])
      return
    }

    const segHeight = cropRect.height / horizontalSegments
    const segWidth = cropRect.width / verticalSegments

    // CRITICAL FIX #6: Limit preview count AND use thumbnail-sized canvas
    const maxPreview = 60
    const THUMB_MAX = 200 // Max preview dimension in pixels
    let count = 0
    const newSegments: SegPreviewItem[] = []
    const newUrls: string[] = []

    // Use a single reusable canvas for all draws — thumbnail-sized
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    if (!ctx) {
      setSegments([])
      return
    }

    let totalToProcess = 0

    for (let h = 0; h < horizontalSegments; h++) {
      for (let v = 0; v < verticalSegments; v++) {
        if (count >= maxPreview) break
        count++
        totalToProcess++
      }
      if (count >= maxPreview) break
    }

    if (totalToProcess === 0) {
      setSegments([])
      return
    }

    count = 0
    let completed = 0

    for (let h = 0; h < horizontalSegments; h++) {
      for (let v = 0; v < verticalSegments; v++) {
        if (count >= maxPreview) break
        count++

        const drawW = Math.max(1, Math.round(segWidth))
        const drawH = Math.max(1, Math.round(segHeight))

        // CRITICAL FIX #6: Scale down to thumbnail size for preview
        // Previously, full-resolution PNG blobs were created (potentially 100MB+ each)
        const scale = Math.min(1, THUMB_MAX / drawW, THUMB_MAX / drawH)
        const thumbW = Math.max(1, Math.round(drawW * scale))
        const thumbH = Math.max(1, Math.round(drawH * scale))

        canvas.width = thumbW
        canvas.height = thumbH

        ctx.clearRect(0, 0, thumbW, thumbH)
        ctx.drawImage(
          image,
          Math.round(cropRect.x + segWidth * v),
          Math.round(cropRect.y + segHeight * h),
          Math.round(segWidth),
          Math.round(segHeight),
          0,
          0,
          thumbW,
          thumbH,
        )

        const currentH = h
        const currentV = v
        const capturedGen = currentGen

        canvas.toBlob((blob) => {
          // CRITICAL FIX #3: Check generation — if stale, discard blob
          if (capturedGen !== generationRef.current) {
            // This is a stale callback — discard the blob, don't create URL
            return
          }

          if (!blob) return
          const url = URL.createObjectURL(blob)
          newUrls.push(url)

          newSegments.push({
            id: `R${currentH + 1}-C${currentV + 1}`,
            row: currentH,
            col: currentV,
            objectUrl: url,
            sw: Math.round(segWidth),
            sh: Math.round(segHeight),
          })

          completed++
          if (completed === totalToProcess) {
            prevUrlsRef.current = newUrls
            setSegments(newSegments)
          }
        }, 'image/png')
      }
      if (count >= maxPreview) break
    }

    // Cleanup: if the effect re-runs before all blobs complete,
    // the generation check will discard them
  }, [image, cropRect, horizontalSegments, verticalSegments])

  const totalSegments = horizontalSegments * verticalSegments
  const showingCount = Math.min(totalSegments, 60)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          Segments Preview
        </h3>
        <span className="text-xs text-muted-foreground">
          {showingCount === totalSegments
            ? `${totalSegments} total`
            : `Showing ${showingCount} of ${totalSegments}`}
        </span>
      </div>
      <div
        className="grid gap-1.5 max-h-80 overflow-y-auto pr-1 custom-scrollbar"
        style={{
          gridTemplateColumns: `repeat(${Math.min(verticalSegments, 6)}, 1fr)`,
        }}
      >
        {segments.map((seg) => (
          <Card
            key={seg.id}
            className="relative overflow-hidden group border border-border/50 hover:border-primary/50 transition-colors"
          >
            <div className="aspect-video relative bg-black/5">
              <img
                src={seg.objectUrl}
                alt={`Segment ${seg.id}`}
                className="w-full h-full object-contain"
                loading="lazy"
              />
            </div>
            <div className="absolute bottom-0 left-0 right-0 bg-black/70 text-white text-[10px] px-1.5 py-0.5 text-center font-mono opacity-0 group-hover:opacity-100 transition-opacity">
              {seg.id} ({seg.sw}x{seg.sh})
            </div>
          </Card>
        ))}
      </div>
      {totalSegments > 60 && (
        <p className="text-xs text-muted-foreground text-center">
          Preview limited to first 60 segments. Export ZIP for all {totalSegments} segments.
        </p>
      )}
    </div>
  )
}
