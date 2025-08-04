import { useEffect, useRef, useState, type MouseEvent, type TouchEvent } from 'react'
import './App.css'

const PIXEL_SIZE = 12
const GRID_SIZE = 32
const CANVAS_SIZE = PIXEL_SIZE * GRID_SIZE

const Colors = {
  White: "#F9FFFE",
  Orange: "#F9801D",
  Magenta: "#C74EBD",
  LightBlue: "#3AB3DA",
  Yellow: "#FED83D",
  Lime: "#80C71F",
  Pink: "#F38BAA",
  Gray: "#474F52",
  LightGray: "#9D9D97",
  Cyan: "#169C9C",
  Purple: "#8932B8",
  Blue: "#3C44AA",
  Brown: "#835432",
  Green: "#5E7C16",
  Red: "#D02E26",
  Black: "#1D1D21",
}

const BRUSH_CHARACTER = '0'
const CURSOR_CHARACTER = 'X'
const BrushSizes = {
  Tiny: `X`,

  Small: `X0
          00`,

  Medium: `_00_
          0X00
          0000
          _00_`,

  Large: `_000_
          00000
          00X00
          00000
          _000_`,
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const [mouseCoords, setMouseCoords] = useState<{ x: number; y: number }>()
  const [strokeDown, setStrokeDown] = useState(false)
  const [brushColor, setBrushColor] = useState<string>(Colors.Red)
  const [brushMap, setBrushMap] = useState<string>()

  // show outline of where stroke will be on canvas
  useEffect(() => {
    const ctx = overlayRef.current?.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)

    if (mouseCoords && !strokeDown) {
      const { x, y } = mouseCoords
      ctx.strokeStyle = 'black'
      ctx.lineWidth = 1
      ctx.strokeRect(x * PIXEL_SIZE + 0.5, y * PIXEL_SIZE + 0.5, PIXEL_SIZE - 1, PIXEL_SIZE - 1)
    }
  }, [mouseCoords])

  const getMouseCoords = (event: MouseEvent<HTMLDivElement>) => {
    if (!canvasRef.current) return
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return

    const { clientX, clientY } = event
    const { left, top } = canvasRef.current.getBoundingClientRect()
    const mouseX = (clientX - left)
    const mouseY = (clientY - top)

    const x = Math.floor(mouseX / PIXEL_SIZE)
    const y = Math.floor(mouseY / PIXEL_SIZE)

    return { x, y }
  }

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const coords = getMouseCoords(event)
    if (!coords) return
    const { x, y } = coords

    if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
      setMouseCoords({ x, y })
    }
    else {
      setMouseCoords(undefined)
    }

    if (!strokeDown) return

    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return

    ctx.fillStyle = brushColor
    drawBrush(ctx, x, y)
  }

  const handleMouseLeave = () => {
    setMouseCoords(undefined);
  }

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    const coords = getMouseCoords(event)
    if (!coords) return
    const { x, y } = coords

    setStrokeDown(true)

    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return

    ctx.fillStyle = brushColor
    drawBrush(ctx, x, y)
  }

  const handleMouseUp = () => {
    setStrokeDown(false)
  }

  const getTouchCoords = (event: TouchEvent<HTMLDivElement>) => {
    if (!canvasRef.current) return
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return

    const { clientX, clientY } = event.touches[0]
    const { left, top } = canvasRef.current.getBoundingClientRect()
    const mouseX = (clientX - left)
    const mouseY = (clientY - top)

    const x = Math.floor(mouseX / PIXEL_SIZE)
    const y = Math.floor(mouseY / PIXEL_SIZE)

    return { x, y }
  }

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const coords = getTouchCoords(event)
    if (!coords) return
    const { x, y } = coords

    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) {
      return
    }

    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return

    ctx.fillStyle = brushColor
    drawBrush(ctx, x, y)
  }

  const drawBrush = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    // remove all white space
    const mapPlain = brushMap?.replace(/\s+/g, '')
    if (!mapPlain || mapPlain.length === 1) {
      ctx.fillRect(x * PIXEL_SIZE, y * PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE)
      return
    }

    const mapSideLength = Math.sqrt(mapPlain.length)
    if (!Number.isInteger(mapSideLength)) {
      throw new Error('Brush map must be a square')
    }
    const cursorIndex = mapPlain.indexOf(CURSOR_CHARACTER)
    if (cursorIndex === -1) {
      console.warn(`No '${CURSOR_CHARACTER}' in brush map, setting to (0, 0)`)
    }

    const brushOffsetX = cursorIndex % mapSideLength
    const brushOffsetY = Math.floor(cursorIndex / mapSideLength)

    mapPlain.split('').forEach((char, index) => {
      if (char === BRUSH_CHARACTER || char === CURSOR_CHARACTER) {
        const dx = index % mapSideLength
        const dy = Math.floor(index / mapSideLength)
        const xCoord = (x + dx - brushOffsetX) * PIXEL_SIZE
        const yCoord = (y + dy - brushOffsetY) * PIXEL_SIZE
        ctx.fillRect(xCoord, yCoord, PIXEL_SIZE, PIXEL_SIZE)
      }
    })
  }

  const handlePalleteClick = (color: string) => {
    return () => setBrushColor(color)
  }

  const handleBrushSelect = (map: string) => {
    return () => setBrushMap(map)
  }

  return (
    <>
      <h1>Joy of Painting</h1>
      <div style={{ position: 'relative', width: CANVAS_SIZE, height: CANVAS_SIZE }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          style={{
            position: 'absolute',
            backgroundColor: Colors.White,
            zIndex: 1,
          }}
        />
        <canvas
          ref={overlayRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          style={{
            position: 'absolute',
            pointerEvents: 'none',
            zIndex: 2
          }}
        />
        <div
          style={{
            touchAction: 'none',
            width: CANVAS_SIZE,
            height: CANVAS_SIZE,
            position: 'absolute',
            zIndex: 3
          }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onMouseDownCapture={handleMouseDown}
          onMouseUp={handleMouseUp}
          onTouchMove={handleTouchMove}
        />
      </div>
      <br />
      <div style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 4,
        marginBottom: 8
      }}>
        {Object.entries(BrushSizes).map(([sizeName, map], index) =>
          <div
            key={sizeName}
            style={{ fontSize: 16 + (8 * index), backgroundColor: Colors.Gray, borderRadius: '2em' }}
            onClick={handleBrushSelect(map)}
          >
            🖌️
          </div>
        )}
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(8, 1fr)',
        gridTemplateRows: 'repeat(2, auto)',
        gap: 8,
        backgroundColor: 'burlywood',
        padding: 16,
        borderTopRightRadius: 10,
        borderBottomRightRadius: 10,
        borderTopLeftRadius: 40,
        borderBottomLeftRadius: 10
      }}>
        {Object.values(Colors).map(color =>
          <div
            key={`pallete_${color}`}
            style={{ backgroundColor: color, width: '2em', height: '2em', borderRadius: '0.4em' }}
            onClick={handlePalleteClick(color)}
          />
        )}
      </div>
    </>
  )
}

export default App
