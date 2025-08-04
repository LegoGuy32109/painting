import { useEffect, useRef, useState, type MouseEvent, type TouchEvent } from 'react'
import './App.css'

const PIXEL_SIZE = 12
const GRID_SIZE = 32
const CANVAS_SIZE = PIXEL_SIZE * GRID_SIZE

type RGB = { r: number, g: number, b: number }
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

const Opacities = {
  Full: 1,
  Half: 0.5,
  Quarter: 0.25,
  Eighth: 0.125
}

const hexToRgb = (hex: string): RGB => {
  hex = hex.replace('#', '')
  const num = parseInt(hex, 16)
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  }
}

const rgbToHex = ({ r, g, b }: RGB): string => {
  const toHex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

const blendColors = (currentColor: string, newColor: string, alpha: number) => {
  const currentRgb = hexToRgb(currentColor)
  const newRgb = hexToRgb(newColor)

  const blendChannel = (newChannel: number, currentChannel: number) => Math.round(newChannel * alpha + currentChannel * (1 - alpha))
  const blendR = blendChannel(newRgb.r, currentRgb.r)
  const blendG = blendChannel(newRgb.g, currentRgb.g)
  const blendB = blendChannel(newRgb.b, currentRgb.b)

  return rgbToHex({ r: blendR, g: blendG, b: blendB })
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const [brushCoords, setBrushCoords] = useState<{ x: number; y: number }>()
  const [strokeDown, setStrokeDown] = useState(false)
  const [brushColor, setBrushColor] = useState<string>(Colors.Red)
  const [brushMap, setBrushMap] = useState<string>(BrushSizes.Medium)
  const [opacity, setOpacity] = useState<number>(Opacities.Full)

  const [canvasData, setCanvasData] = useState<string[][]>(Array.from({ length: GRID_SIZE }, () => Array.from({ length: GRID_SIZE }, () => Colors.White)))

  // show outline of where stroke will be on canvas
  useEffect(() => {
    const ctx = overlayRef.current?.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)

    if (brushCoords && !strokeDown) {
      const { x, y } = brushCoords
      ctx.strokeStyle = 'black'
      ctx.lineWidth = 1
      ctx.strokeRect(x * PIXEL_SIZE + 0.5, y * PIXEL_SIZE + 0.5, PIXEL_SIZE - 1, PIXEL_SIZE - 1)
    }
  }, [brushCoords])

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)

    let x = 0
    let y = 0
    for (const column of canvasData) {
      for (const color of column) {
        ctx.fillStyle = color
        ctx.fillRect(x * PIXEL_SIZE, y * PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE)
        y += 1
      }
      x += 1
      y = 0
    }

  }, [canvasData])

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

    // don't draw out of bounds
    if (x < 0 || x >= GRID_SIZE || y < 0 && y >= GRID_SIZE) {
      setBrushCoords(undefined)
      return
    }
    // don't re-paint on same pixel
    if (brushCoords?.x === x && brushCoords?.y === y) {
      return
    }
    setBrushCoords({ x, y })

    if (!strokeDown) return

    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return

    ctx.fillStyle = brushColor
    drawBrush(x, y)
  }

  const handleMouseLeave = () => {
    setBrushCoords(undefined);
  }

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    const coords = getMouseCoords(event)
    if (!coords) return
    const { x, y } = coords

    setStrokeDown(true)

    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return

    ctx.fillStyle = brushColor
    drawBrush(x, y)
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
    drawBrush(x, y)
  }

  const drawBrush = (x: number, y: number) => {
    // remove all white space
    const mapPlain = brushMap?.replace(/\s+/g, '')
    if (!mapPlain) {
      return
    }

    const mapSideLength = Math.sqrt(mapPlain.length)
    if (!Number.isInteger(mapSideLength)) {
      throw new Error('Brush map must be a square')
    }
    let cursorIndex = mapPlain.indexOf(CURSOR_CHARACTER)
    if (cursorIndex === -1) {
      console.warn(`No '${CURSOR_CHARACTER}' in brush map, setting to (0, 0)`)
      cursorIndex = 0
    }

    const brushOffsetX = cursorIndex % mapSideLength
    const brushOffsetY = Math.floor(cursorIndex / mapSideLength)

    const stroke: Array<{ x: number, y: number, color: string }> = []
    mapPlain.split('').forEach((char, index) => {
      if (char === BRUSH_CHARACTER || char === CURSOR_CHARACTER) {
        const dx = index % mapSideLength
        const dy = Math.floor(index / mapSideLength)
        const xCoord = (x + dx - brushOffsetX)
        const yCoord = (y + dy - brushOffsetY)
        if (xCoord >= 0 && xCoord < GRID_SIZE && yCoord >= 0 && yCoord < GRID_SIZE) {
          //const currentColor = canvasData[xCoord][yCoord]
          //const newColor = blendColors(currentColor, brushColor, opacity)
          stroke.push({ x: xCoord, y: yCoord, color: brushColor })
        }
      }
    })

    // determine if the state variable needs to be updated
    //if (stroke.some(({ x, y, color }) => canvasData[x][y] !== color)) {
      setCanvasData(canvas => {
        const newCanvas = canvas.map(row => [...row])
        for (const { x, y, color } of stroke) {
          newCanvas[x][y] = color
        }
        return newCanvas
      })
    //}
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
        {Object.entries(Opacities).map(([name, alpha]) =>
          <div
            key={name}
            style={{ height: 32, width: 32, backgroundColor: Colors.Red, opacity: alpha }}
            onClick={() => setOpacity(alpha)}
          />)}
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
