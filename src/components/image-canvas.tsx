'use client'

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react'

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SegSize {
  width: number
  height: number
}

export type ZoomMode = 'fit-width' | 'fit-all'

interface ImageCanvasProps {
  image: HTMLImageElement
  cropRect: CropRect
  onCropChange: (rect: CropRect) => void
  horizontalSegments: number
  verticalSegments: number
  customHGridPcts?: number[]
  /** Gap shading regions as percentages — each is [startPct, endPct] */
  hGapRegions?: [number, number][]
  vGapRegions?: [number, number][]
  showSegBox?: boolean
  segSize: SegSize
  onSegSizeChange?: (size: SegSize) => void
  /** Gap between segments in image pixels */
  segGap: SegSize
  onSegGapChange?: (gap: SegSize) => void
  showGrid: boolean
  zoomMode: ZoomMode
  onZoomPercentChange?: (percent: number) => void
}

type HandleType =
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  | 'top' | 'right' | 'bottom' | 'left'
  | 'move' | null

type SegHandleType = 'seg-right' | 'seg-bottom' | 'seg-corner' | null
type GapHandleType = 'gap-right' | 'gap-bottom' | 'gap-corner' | null

const HANDLE_SIZE = 14
const MIN_CROP_SIZE = 20
const MIN_SEG = 5
const MIN_GAP = 0
const PAD = 16
const SCROLL_ZONE = 80
const SCROLL_SPEED = 30

const CROP_HANDLES: {
  type: Exclude<HandleType, 'move' | null>
  cursor: string
  xp: string
  yp: string
  corner: boolean
  vert: boolean
}[] = [
  { type: 'top-left', cursor: 'nwse-resize', xp: '0%', yp: '0%', corner: true, vert: false },
  { type: 'top-right', cursor: 'nesw-resize', xp: '100%', yp: '0%', corner: true, vert: false },
  { type: 'bottom-left', cursor: 'nesw-resize', xp: '0%', yp: '100%', corner: true, vert: false },
  { type: 'bottom-right', cursor: 'nwse-resize', xp: '100%', yp: '100%', corner: true, vert: false },
  { type: 'top', cursor: 'ns-resize', xp: '50%', yp: '0%', corner: false, vert: false },
  { type: 'bottom', cursor: 'ns-resize', xp: '50%', yp: '100%', corner: false, vert: false },
  { type: 'left', cursor: 'ew-resize', xp: '0%', yp: '50%', corner: false, vert: true },
  { type: 'right', cursor: 'ew-resize', xp: '100%', yp: '50%', corner: false, vert: true },
]

export default function ImageCanvas({
  image, cropRect, onCropChange,
  horizontalSegments, verticalSegments,
  customHGridPcts, hGapRegions, vGapRegions,
  showSegBox, segSize, onSegSizeChange,
  segGap, onSegGapChange,
  showGrid, zoomMode, onZoomPercentChange,
}: ImageCanvasProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const cropElRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const segBoxRef = useRef<HTMLDivElement>(null)
  const segLabelRef = useRef<HTMLDivElement>(null)
  const gapBoxRef = useRef<HTMLDivElement>(null)
  const gapLabelRef = useRef<HTMLDivElement>(null)

  const [cw, setCw] = useState(800)
  const [ch, setCh] = useState(600)
  const [zoom, setZoom] = useState(1)

  // ─── Crop drag state ────────────────────────────────────────────
  const isDrag = useRef(false)
  const liveCrop = useRef<CropRect>({ ...cropRect })
  const dragRef = useRef({
    on: false, handle: null as HandleType,
    sx: 0, sy: 0, ssx: 0, ssy: 0,
    sc: { x: 0, y: 0, width: 0, height: 0 } as CropRect,
    mx: 0, my: 0, raf: null as number | null, cursor: '',
  })

  // ─── Segment box drag state ─────────────────────────────────────
  const isSegDrag = useRef(false)
  const segDragRef = useRef({
    on: false, handle: null as SegHandleType,
    startX: 0, startY: 0, startScrollX: 0, startScrollY: 0,
    startW: 0, startH: 0, mx: 0, my: 0, raf: null as number | null,
  })

  // ─── Gap box drag state ─────────────────────────────────────────
  const isGapDrag = useRef(false)
  const gapDragRef = useRef({
    on: false, handle: null as GapHandleType,
    startX: 0, startY: 0, startScrollX: 0, startScrollY: 0,
    startW: 0, startH: 0, mx: 0, my: 0, raf: null as number | null,
  })

  // ─── Scale ──────────────────────────────────────────────────────
  const base = useMemo(() => {
    const aw = cw - 4
    if (zoomMode === 'fit-width') return Math.max(0.05, aw / image.naturalWidth)
    return Math.max(0.05, Math.min(aw / image.naturalWidth, (ch - 4) / image.naturalHeight))
  }, [zoomMode, cw, ch, image])

  const sc = Math.max(0.02, base * zoom)
  const iw = Math.ceil(image.naturalWidth * sc)
  const ih = Math.ceil(image.naturalHeight * sc)
  const ww = iw + PAD * 2
  const wh = ih + PAD * 2

  const pRef = useRef({ sc, ww, wh, iw, ih })
  useEffect(() => { pRef.current = { sc, ww, wh, iw, ih } }, [sc, ww, wh, iw, ih])

  // ─── Container resize ──────────────────────────────────────────
  useEffect(() => {
    const fn = () => {
      if (scrollRef.current) {
        const r = scrollRef.current.getBoundingClientRect()
        setCw(r.width); setCh(r.height)
      }
    }
    fn()
    const o = new ResizeObserver(fn)
    if (scrollRef.current) o.observe(scrollRef.current)
    return () => o.disconnect()
  }, [])

  const zp = Math.round(sc * 100)
  // Use ref to avoid re-rendering parent on every zoom change during drag
  const onZoomPercentChangeRef = useRef(onZoomPercentChange)
  onZoomPercentChangeRef.current = onZoomPercentChange
  useEffect(() => { onZoomPercentChangeRef.current?.(zp) }, [zp])

  useEffect(() => {
    if (!isDrag.current) liveCrop.current = { ...cropRect }
  }, [cropRect])

  // ─── Display positions ─────────────────────────────────────────
  const cl = cropRect.x * sc + PAD
  const ct = cropRect.y * sc + PAD
  const cwidth = cropRect.width * sc
  const cheight = cropRect.height * sc

  // ─── Segment box display ───────────────────────────────────────
  const segBoxW = Math.min(segSize.width * sc, cwidth)
  const segBoxH = Math.min(segSize.height * sc, cheight)
  // Gap box sits directly below the segment box (vertical gap) and to the right (horizontal gap)
  const gapBoxW = Math.min(segGap.width * sc, cwidth)
  const gapBoxH = Math.min(segGap.height * sc, cheight)

  // ─── Grid lines ────────────────────────────────────────────────
  const hPcts = useMemo(() => {
    if (!showGrid) return []
    if (customHGridPcts && customHGridPcts.length > 0) return customHGridPcts
    if (horizontalSegments <= 1) return []
    return Array.from({ length: horizontalSegments - 1 }, (_, i) => ((i + 1) / horizontalSegments) * 100)
  }, [showGrid, horizontalSegments, customHGridPcts])

  const vPcts = useMemo(() => {
    if (!showGrid || verticalSegments <= 1) return []
    return Array.from({ length: verticalSegments - 1 }, (_, i) => ((i + 1) / verticalSegments) * 100)
  }, [showGrid, verticalSegments])

  const hBounds = useMemo(() => {
    if (customHGridPcts && customHGridPcts.length > 0) return [0, ...customHGridPcts, 100]
    return Array.from({ length: horizontalSegments + 1 }, (_, i) => (i / horizontalSegments) * 100)
  }, [horizontalSegments, customHGridPcts])

  // ─── Segment labels ────────────────────────────────────────────
  const labels = useMemo(() => {
    if (!showGrid || !horizontalSegments || !verticalSegments) return []
    const arr: { t: string; x: number; y: number; pctH: number; pctW: number; sm: boolean }[] = []
    for (let h = 0; h < horizontalSegments; h++) {
      const segTopPct = hBounds[h]
      const segBotPct = hBounds[h + 1]
      const segHPct = segBotPct - segTopPct
      const segCenterY = (segTopPct + segBotPct) / 2
      const segDisplayH = (segHPct / 100) * cheight
      for (let v = 0; v < verticalSegments; v++) {
        const segWPct = 100 / verticalSegments
        const segDisplayW = (segWPct / 100) * cwidth
        if (segDisplayW >= 22 && segDisplayH >= 22) {
          arr.push({ t: horizontalSegments > 20 || verticalSegments > 10 ? `${h + 1}.${v + 1}` : `H${h + 1}-V${v + 1}`, x: segWPct * (v + 0.5), y: segCenterY, pctH: segHPct, pctW: segWPct, sm: false })
        } else if (segDisplayH >= 10) {
          arr.push({ t: `${h + 1}`, x: 1.5, y: segCenterY, pctH: segHPct, pctW: segWPct, sm: true })
        }
      }
    }
    return arr
  }, [showGrid, horizontalSegments, verticalSegments, cwidth, cheight, hBounds])

  // ─── Compute crop from drag ────────────────────────────────────
  const computeCrop = useCallback((h: HandleType, s: CropRect, dx: number, dy: number): CropRect => {
    const r = { ...s }
    const W = image.naturalWidth, H = image.naturalHeight
    switch (h) {
      case 'move': r.x = Math.max(0, Math.min(W - r.width, r.x + dx)); r.y = Math.max(0, Math.min(H - r.height, r.y + dy)); break
      case 'top-left': r.x = Math.min(s.x + s.width - MIN_CROP_SIZE, Math.max(0, s.x + dx)); r.y = Math.min(s.y + s.height - MIN_CROP_SIZE, Math.max(0, s.y + dy)); r.width = s.x + s.width - r.x; r.height = s.y + s.height - r.y; break
      case 'top-right': r.width = Math.max(MIN_CROP_SIZE, Math.min(W - r.x, s.width + dx)); r.y = Math.min(s.y + s.height - MIN_CROP_SIZE, Math.max(0, s.y + dy)); r.height = s.y + s.height - r.y; break
      case 'bottom-left': r.x = Math.min(s.x + s.width - MIN_CROP_SIZE, Math.max(0, s.x + dx)); r.width = s.x + s.width - r.x; r.height = Math.max(MIN_CROP_SIZE, Math.min(H - r.y, s.height + dy)); break
      case 'bottom-right': r.width = Math.max(MIN_CROP_SIZE, Math.min(W - r.x, s.width + dx)); r.height = Math.max(MIN_CROP_SIZE, Math.min(H - r.y, s.height + dy)); break
      case 'top': r.y = Math.min(s.y + s.height - MIN_CROP_SIZE, Math.max(0, s.y + dy)); r.height = s.y + s.height - r.y; break
      case 'bottom': r.height = Math.max(MIN_CROP_SIZE, Math.min(H - r.y, s.height + dy)); break
      case 'left': r.x = Math.min(s.x + s.width - MIN_CROP_SIZE, Math.max(0, s.x + dx)); r.width = s.x + s.width - r.x; break
      case 'right': r.width = Math.max(MIN_CROP_SIZE, Math.min(W - r.x, s.width + dx)); break
    }
    return r
  }, [image])

  // ─── Start crop drag ───────────────────────────────────────────
  const startCropDrag = useCallback((handle: HandleType, cx: number, cy: number) => {
    const d = dragRef.current; const container = scrollRef.current; if (!container) return
    d.on = true; d.handle = handle; d.sx = cx; d.sy = cy; d.ssx = container.scrollLeft; d.ssy = container.scrollTop; d.mx = cx; d.my = cy; d.sc = { ...liveCrop.current }
    d.cursor = handle === 'move' ? 'move' : CROP_HANDLES.find((h) => h.type === handle)?.cursor || 'default'
    isDrag.current = true; if (scrollRef.current) scrollRef.current.style.cursor = d.cursor
    const loop = () => {
      if (!d.on) return; const cont = scrollRef.current; if (!cont) { d.raf = requestAnimationFrame(loop); return }
      const cr = cont.getBoundingClientRect(); const z = SCROLL_ZONE, sp = SCROLL_SPEED
      if (d.my > cr.bottom - z && d.my <= cr.bottom + 30) cont.scrollTop += Math.ceil(Math.min(1, (d.my - (cr.bottom - z)) / z) * sp)
      if (d.my < cr.top + z && d.my >= cr.top - 30) cont.scrollTop -= Math.ceil(Math.min(1, ((cr.top + z) - d.my) / z) * sp)
      if (d.mx > cr.right - z && d.mx <= cr.right + 30) cont.scrollLeft += Math.ceil(Math.min(1, (d.mx - (cr.right - z)) / z) * sp)
      if (d.mx < cr.left + z && d.mx >= cr.left - 30) cont.scrollLeft -= Math.ceil(Math.min(1, ((cr.left + z) - d.mx) / z) * sp)
      const sdx = cont.scrollLeft - d.ssx, sdy = cont.scrollTop - d.ssy; const p = pRef.current
      const nc = computeCrop(d.handle, d.sc, (d.mx - d.sx + sdx) / p.sc, (d.my - d.sy + sdy) / p.sc)
      liveCrop.current = nc
      const el = cropElRef.current; if (el) { el.style.left = `${nc.x * p.sc + PAD}px`; el.style.top = `${nc.y * p.sc + PAD}px`; el.style.width = `${nc.width * p.sc}px`; el.style.height = `${nc.height * p.sc}px` }
      const lb = labelRef.current; if (lb) lb.textContent = `${Math.round(nc.width)} × ${Math.round(nc.height)}`
      d.raf = requestAnimationFrame(loop)
    }; d.raf = requestAnimationFrame(loop)
  }, [computeCrop])

  const stopCropDrag = useCallback(() => {
    const d = dragRef.current; if (d.raf != null) { cancelAnimationFrame(d.raf); d.raf = null }
    d.on = false; d.handle = null; isDrag.current = false; if (scrollRef.current) scrollRef.current.style.cursor = ''
    onCropChange({ ...liveCrop.current })
  }, [onCropChange])

  // ─── Start segment box drag ────────────────────────────────────
  const startSegDrag = useCallback((handle: SegHandleType, cx: number, cy: number) => {
    if (!showSegBox || !onSegSizeChange) return; const container = scrollRef.current; if (!container) return
    const sd = segDragRef.current; sd.on = true; sd.handle = handle; sd.startX = cx; sd.startY = cy; sd.startScrollX = container.scrollLeft; sd.startScrollY = container.scrollTop; sd.startW = segSize.width; sd.startH = segSize.height; sd.mx = cx; sd.my = cy
    isSegDrag.current = true; if (scrollRef.current) scrollRef.current.style.cursor = handle === 'seg-corner' ? 'nwse-resize' : handle === 'seg-bottom' ? 'ns-resize' : 'ew-resize'
    const loop = () => {
      if (!sd.on) return; const cont = scrollRef.current; if (!cont) { sd.raf = requestAnimationFrame(loop); return }
      const cr = cont.getBoundingClientRect(); const z = SCROLL_ZONE, sp = SCROLL_SPEED
      if (sd.my > cr.bottom - z && sd.my <= cr.bottom + 30) cont.scrollTop += Math.ceil(Math.min(1, (sd.my - (cr.bottom - z)) / z) * sp)
      if (sd.my < cr.top + z && sd.my >= cr.top - 30) cont.scrollTop -= Math.ceil(Math.min(1, ((cr.top + z) - sd.my) / z) * sp)
      if (sd.mx > cr.right - z && sd.mx <= cr.right + 30) cont.scrollLeft += Math.ceil(Math.min(1, (sd.mx - (cr.right - z)) / z) * sp)
      if (sd.mx < cr.left + z && sd.mx >= cr.left - 30) cont.scrollLeft -= Math.ceil(Math.min(1, ((cr.left + z) - sd.mx) / z) * sp)
      const sdx = cont.scrollLeft - sd.startScrollX, sdy = cont.scrollTop - sd.startScrollY; const p = pRef.current
      const deltaImgX = (sd.mx - sd.startX + sdx) / p.sc, deltaImgY = (sd.my - sd.startY + sdy) / p.sc
      let newW = sd.startW, newH = sd.startH
      if (sd.handle === 'seg-right' || sd.handle === 'seg-corner') newW = Math.max(MIN_SEG, Math.min(cropRect.width, sd.startW + deltaImgX))
      if (sd.handle === 'seg-bottom' || sd.handle === 'seg-corner') newH = Math.max(MIN_SEG, Math.min(cropRect.height, sd.startH + deltaImgY))
      const sb = segBoxRef.current; if (sb) { sb.style.width = `${newW * p.sc}px`; sb.style.height = `${newH * p.sc}px` }
      const sl = segLabelRef.current; if (sl) sl.textContent = `${Math.round(newW)} × ${Math.round(newH)} px`
      onSegSizeChange({ width: Math.round(newW), height: Math.round(newH) })
      sd.raf = requestAnimationFrame(loop)
    }; sd.raf = requestAnimationFrame(loop)
  }, [showSegBox, onSegSizeChange, segSize, cropRect])

  const stopSegDrag = useCallback(() => {
    const sd = segDragRef.current; if (sd.raf != null) { cancelAnimationFrame(sd.raf); sd.raf = null }
    sd.on = false; sd.handle = null; isSegDrag.current = false; if (scrollRef.current) scrollRef.current.style.cursor = ''
  }, [])

  // ─── Start gap box drag ────────────────────────────────────────
  const startGapDrag = useCallback((handle: GapHandleType, cx: number, cy: number) => {
    if (!showSegBox || !onSegGapChange) return; const container = scrollRef.current; if (!container) return
    const gd = gapDragRef.current; gd.on = true; gd.handle = handle; gd.startX = cx; gd.startY = cy; gd.startScrollX = container.scrollLeft; gd.startScrollY = container.scrollTop; gd.startW = segGap.width; gd.startH = segGap.height; gd.mx = cx; gd.my = cy
    isGapDrag.current = true; if (scrollRef.current) scrollRef.current.style.cursor = handle === 'gap-corner' ? 'nwse-resize' : handle === 'gap-bottom' ? 'ns-resize' : 'ew-resize'
    const loop = () => {
      if (!gd.on) return; const cont = scrollRef.current; if (!cont) { gd.raf = requestAnimationFrame(loop); return }
      const cr = cont.getBoundingClientRect(); const z = SCROLL_ZONE, sp = SCROLL_SPEED
      if (gd.my > cr.bottom - z && gd.my <= cr.bottom + 30) cont.scrollTop += Math.ceil(Math.min(1, (gd.my - (cr.bottom - z)) / z) * sp)
      if (gd.my < cr.top + z && gd.my >= cr.top - 30) cont.scrollTop -= Math.ceil(Math.min(1, ((cr.top + z) - gd.my) / z) * sp)
      if (gd.mx > cr.right - z && gd.mx <= cr.right + 30) cont.scrollLeft += Math.ceil(Math.min(1, (gd.mx - (cr.right - z)) / z) * sp)
      if (gd.mx < cr.left + z && gd.mx >= cr.left - 30) cont.scrollLeft -= Math.ceil(Math.min(1, ((cr.left + z) - gd.mx) / z) * sp)
      const sdx = cont.scrollLeft - gd.startScrollX, sdy = cont.scrollTop - gd.startScrollY; const p = pRef.current
      const deltaImgX = (gd.mx - gd.startX + sdx) / p.sc, deltaImgY = (gd.my - gd.startY + sdy) / p.sc
      let newW = gd.startW, newH = gd.startH
      if (gd.handle === 'gap-right' || gd.handle === 'gap-corner') newW = Math.max(MIN_GAP, Math.min(cropRect.width - segSize.width, gd.startW + deltaImgX))
      if (gd.handle === 'gap-bottom' || gd.handle === 'gap-corner') newH = Math.max(MIN_GAP, Math.min(cropRect.height - segSize.height, gd.startH + deltaImgY))
      const gb = gapBoxRef.current; if (gb) { gb.style.width = `${newW * p.sc}px`; gb.style.height = `${newH * p.sc}px` }
      const gl = gapLabelRef.current; if (gl) gl.textContent = `Gap: ${Math.round(newW)} × ${Math.round(newH)} px`
      onSegGapChange({ width: Math.round(newW), height: Math.round(newH) })
      gd.raf = requestAnimationFrame(loop)
    }; gd.raf = requestAnimationFrame(loop)
  }, [showSegBox, onSegGapChange, segGap, segSize, cropRect])

  const stopGapDrag = useCallback(() => {
    const gd = gapDragRef.current; if (gd.raf != null) { cancelAnimationFrame(gd.raf); gd.raf = null }
    gd.on = false; gd.handle = null; isGapDrag.current = false; if (scrollRef.current) scrollRef.current.style.cursor = ''
  }, [])

  // ─── Document mouse events ─────────────────────────────────────
  useEffect(() => {
    const mm = (e: MouseEvent) => {
      if (dragRef.current.on) { e.preventDefault(); dragRef.current.mx = e.clientX; dragRef.current.my = e.clientY }
      if (segDragRef.current.on) { e.preventDefault(); segDragRef.current.mx = e.clientX; segDragRef.current.my = e.clientY }
      if (gapDragRef.current.on) { e.preventDefault(); gapDragRef.current.mx = e.clientX; gapDragRef.current.my = e.clientY }
    }
    const mu = () => {
      if (dragRef.current.on) stopCropDrag()
      if (segDragRef.current.on) stopSegDrag()
      if (gapDragRef.current.on) stopGapDrag()
    }
    document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu)
    return () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu) }
  }, [stopCropDrag, stopSegDrag, stopGapDrag])

  // ─── Ctrl+wheel zoom ───────────────────────────────────────────
  useEffect(() => {
    const c = scrollRef.current; if (!c) return
    const fn = (e: WheelEvent) => {
      if ((e.ctrlKey || e.metaKey) && !isDrag.current && !isSegDrag.current && !isGapDrag.current) {
        e.preventDefault(); e.stopPropagation()
        setZoom((p) => Math.max(0.1, Math.min(10, p * (e.deltaY > 0 ? 0.9 : 1.1))))
      }
    }
    c.addEventListener('wheel', fn, { passive: false }); return () => c.removeEventListener('wheel', fn)
  }, [])

  return (
    <div ref={scrollRef} className="w-full h-full rounded-lg border border-border bg-[#0f0f0f] overflow-auto custom-scrollbar">
      <div ref={wrapperRef} style={{ width: ww, height: wh, position: 'relative', minWidth: ww, minHeight: wh }}>
        {/* Image */}
        <img src={image.src} alt="" draggable={false} style={{ position: 'absolute', left: PAD, top: PAD, width: iw, height: ih, userSelect: 'none', pointerEvents: 'none' }} />

        {/* Crop area */}
        <div ref={cropElRef} style={{ position: 'absolute', left: cl, top: ct, width: cwidth, height: cheight, boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)', border: '2px solid #fff', overflow: 'visible', cursor: 'move' }}
          onMouseDown={(e) => { e.preventDefault(); startCropDrag('move', e.clientX, e.clientY) }}>

          {/* Gap shading regions — horizontal */}
          {hGapRegions?.map(([start, end], i) => (
            <div key={`hgr${i}`} style={{ position: 'absolute', left: 0, right: 0, top: `${start}%`, height: `${end - start}%`, background: 'rgba(239, 68, 68, 0.15)', pointerEvents: 'none' }} />
          ))}
          {/* Gap shading regions — vertical */}
          {vGapRegions?.map(([start, end], i) => (
            <div key={`vgr${i}`} style={{ position: 'absolute', top: 0, bottom: 0, left: `${start}%`, width: `${end - start}%`, background: 'rgba(239, 68, 68, 0.15)', pointerEvents: 'none' }} />
          ))}

          {/* Horizontal grid lines */}
          {hPcts.map((p, i) => (<div key={`h${i}`} style={{ position: 'absolute', left: 0, right: 0, top: `${p}%`, borderTop: '1px dashed rgba(255,200,50,0.7)', pointerEvents: 'none' }} />))}
          {/* Vertical grid lines */}
          {vPcts.map((p, i) => (<div key={`v${i}`} style={{ position: 'absolute', top: 0, bottom: 0, left: `${p}%`, borderLeft: '1px dashed rgba(255,200,50,0.7)', pointerEvents: 'none' }} />))}

          {/* Segment labels */}
          {labels.map((l, i) => (<div key={`l${i}`} style={{ position: 'absolute', left: `${l.x}%`, top: `${l.y}%`, transform: 'translate(-50%,-50%)', pointerEvents: 'none', fontFamily: 'monospace', whiteSpace: 'nowrap', borderRadius: 2, fontSize: l.sm ? Math.max(6, Math.min(9, Math.floor((l.pctH / 100) * cheight * 0.6))) : Math.max(7, Math.min(11, Math.floor(Math.min((l.pctW / 100) * cwidth / 5, (l.pctH / 100) * cheight / 2)))), color: l.sm ? 'rgba(255,200,50,0.95)' : 'rgba(255,255,255,0.9)', background: l.sm ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.6)', padding: l.sm ? '1px 2px' : '2px 3px' }}>{l.t}</div>))}

          {/* ─── Segment Size Box (amber) ──────────────────────── */}
          {showSegBox && (
            <div ref={segBoxRef} style={{ position: 'absolute', left: 0, top: 0, width: segBoxW, height: segBoxH, border: '2px solid #f59e0b', background: 'rgba(245, 158, 11, 0.08)', zIndex: 20, pointerEvents: 'auto' }}
              onMouseDown={(e) => e.stopPropagation()}>
              <div ref={segLabelRef} style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', fontSize: 11, fontFamily: 'monospace', color: '#f59e0b', background: 'rgba(0,0,0,0.8)', padding: '3px 8px', borderRadius: 3, whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 25 }}>
                {Math.round(segSize.width)} × {Math.round(segSize.height)} px
              </div>
              {/* Right handle */}
              <div style={{ position: 'absolute', right: -6, top: 0, bottom: 0, width: 12, cursor: 'ew-resize', zIndex: 25, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startSegDrag('seg-right', e.clientX, e.clientY) }}>
                <div style={{ width: 6, height: 32, background: '#f59e0b', borderRadius: 3, border: '1px solid #000' }} />
              </div>
              {/* Bottom handle */}
              <div style={{ position: 'absolute', bottom: -6, left: 0, right: 0, height: 12, cursor: 'ns-resize', zIndex: 25, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startSegDrag('seg-bottom', e.clientX, e.clientY) }}>
                <div style={{ height: 6, width: 32, background: '#f59e0b', borderRadius: 3, border: '1px solid #000' }} />
              </div>
              {/* Corner handle */}
              <div style={{ position: 'absolute', right: -8, bottom: -8, width: 16, height: 16, background: '#f59e0b', border: '1.5px solid #000', borderRadius: 2, cursor: 'nwse-resize', zIndex: 26 }}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startSegDrag('seg-corner', e.clientX, e.clientY) }} />

              {/* ─── Gap Box (red/coral) — below segment box ────── */}
              <div
                ref={gapBoxRef}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: '100%',
                  width: gapBoxW || segBoxW,
                  height: gapBoxH || 20,
                  border: '2px solid #ef4444',
                  background: 'rgba(239, 68, 68, 0.12)',
                  zIndex: 20,
                  pointerEvents: 'auto',
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div ref={gapLabelRef} style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', fontSize: 10, fontFamily: 'monospace', color: '#ef4444', background: 'rgba(0,0,0,0.85)', padding: '2px 6px', borderRadius: 3, whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 25 }}>
                  Gap: {Math.round(segGap.width)} × {Math.round(segGap.height)} px
                </div>
                {/* Gap right handle */}
                <div style={{ position: 'absolute', right: -6, top: 0, bottom: 0, width: 12, cursor: 'ew-resize', zIndex: 25, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startGapDrag('gap-right', e.clientX, e.clientY) }}>
                  <div style={{ width: 5, height: 24, background: '#ef4444', borderRadius: 2, border: '1px solid #000' }} />
                </div>
                {/* Gap bottom handle */}
                <div style={{ position: 'absolute', bottom: -6, left: 0, right: 0, height: 12, cursor: 'ns-resize', zIndex: 25, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startGapDrag('gap-bottom', e.clientX, e.clientY) }}>
                  <div style={{ height: 5, width: 24, background: '#ef4444', borderRadius: 2, border: '1px solid #000' }} />
                </div>
                {/* Gap corner handle */}
                <div style={{ position: 'absolute', right: -8, bottom: -8, width: 14, height: 14, background: '#ef4444', border: '1.5px solid #000', borderRadius: 2, cursor: 'nwse-resize', zIndex: 26 }}
                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startGapDrag('gap-corner', e.clientX, e.clientY) }} />
              </div>
            </div>
          )}

          {/* Crop handles */}
          {CROP_HANDLES.map(({ type, cursor, xp, yp, corner, vert }) => {
            const sz = corner ? HANDLE_SIZE + 2 : HANDLE_SIZE; const w = corner ? sz : vert ? sz + 4 : sz * 2; const h = corner ? sz : vert ? sz * 2 : sz + 4
            return (<div key={type} style={{ position: 'absolute', left: xp, top: yp, width: w, height: h, transform: 'translate(-50%, -50%)', background: '#fff', border: '1.5px solid #000', borderRadius: corner ? 0 : 2, cursor, zIndex: 10 }}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startCropDrag(type, e.clientX, e.clientY) }} />)
          })}

          {/* Dimension label */}
          <div ref={labelRef} style={{ position: 'absolute', left: '50%', top: 'calc(100% + 8px)', transform: 'translateX(-50%)', fontSize: 12, fontFamily: 'monospace', color: 'rgba(255,255,255,0.95)', background: 'rgba(0,0,0,0.7)', padding: '2px 4px', borderRadius: 2, whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 10 }}>
            {Math.round(cropRect.width)} × {Math.round(cropRect.height)}
          </div>
        </div>
      </div>
    </div>
  )
}
