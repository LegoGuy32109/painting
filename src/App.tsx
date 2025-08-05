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

const makeMatrix = <T,>(length: number, value: T): T[][] => Array.from({ length }, () => Array.from({ length }, () => value))

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const [brushCoords, setBrushCoords] = useState<{ x: number; y: number }>()
  const [strokeDown, setStrokeDown] = useState(false)

  // what's being rendered on screen
  // state to restore session on load kept here
  type CanvasData = {
    canvas: string[][],
    brushColor: string,
    brushMap: string,
    opacity: number
  }
  const [canvasData, setCanvasData] = useState<CanvasData>({
    canvas: makeMatrix(GRID_SIZE, Colors.White),
    brushColor: Colors.Red,
    brushMap: BrushSizes.Tiny,
    opacity: Opacities.Full
  })

  // the current stroke with mouse / touch down
  const [, setStrokeData] = useState<boolean[][]>(makeMatrix(GRID_SIZE, false))
  // snapshots of painting for undo
  const [, setCanvasHistory] = useState<string[][][]>([])

  useEffect(() => {
    const endStroke = (_: unknown) => {
      setStrokeDown(isStrokeDown => {
        // don't trigger if a stroke wasn't started on canvas
        if (isStrokeDown) {
          setStrokeData(currentStrokeData => {
            setCanvasData(prev => {
              setCanvasHistory(history => {
                // only save snapshot if edit makes distinct change
                if (history.length > 0 && prev.canvas.some((row, x) => row.some((cell, y) => cell !== history[0][x][y]))) {
                  return [prev.canvas, ...history.slice(0, 10)]
                }
                return history
              })
              const newCanvas = overlayStrokeData(prev, currentStrokeData)
              if (!newCanvas) console.warn('error overlaying stroke')
              return { ...prev, canvas: newCanvas ?? prev.canvas }
            })
            return makeMatrix(GRID_SIZE, false)
          })
        }
        return false
      })
    }

    window.addEventListener('mouseup', endStroke);
    window.addEventListener('touchend', endStroke);
    return () => {
      window.removeEventListener('mouseup', endStroke)
      window.removeEventListener('touchend', endStroke)
    }
  }, []);

  const getMouseCoords = (event: MouseEvent<HTMLDivElement>) => {
    if (!canvasRef.current) return

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
    drawBrush(x, y)
  }

  const getTouchCoords = (event: TouchEvent<HTMLDivElement>) => {
    if (!canvasRef.current) return

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

    if (!strokeDown) return
    drawBrush(x, y)
  }

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const { touches } = event
    setStrokeDown(touches.length === 1)
  }

  const handleTouchEnd = (_: TouchEvent<HTMLDivElement>) => {
    setStrokeDown(false)
  }

  const drawBrush = (x: number, y: number) => {
    // remove all white space
    const mapPlain = canvasData.brushMap?.replace(/\s+/g, '')
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

    const stroke: Array<{ x: number, y: number }> = []
    mapPlain.split('').forEach((char, index) => {
      if (char === BRUSH_CHARACTER || char === CURSOR_CHARACTER) {
        const dx = index % mapSideLength
        const dy = Math.floor(index / mapSideLength)
        const xCoord = (x + dx - brushOffsetX)
        const yCoord = (y + dy - brushOffsetY)
        if (xCoord >= 0 && xCoord < GRID_SIZE && yCoord >= 0 && yCoord < GRID_SIZE) {
          stroke.push({ x: xCoord, y: yCoord })
        }
      }
    })

    // render stroke on overlay to not affect cavas
    const overlayCtx = overlayRef.current?.getContext('2d')
    const { canvas, brushColor, opacity } = canvasData

    setStrokeData(strokeData => {
      const updatedData = strokeData.map(row => [...row])
      for (const { x, y } of stroke) {
        updatedData[x][y] = true
        if (overlayCtx) {
          overlayCtx.fillStyle = blendColors(canvas[x][y], brushColor, opacity)
          overlayCtx.fillRect(x * PIXEL_SIZE, y * PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE)

          // TODO: show outline of where stroke will be on canvas
          //overlayCtx.strokeStyle = 'black'
          //overlayCtx.lineWidth = 1
          //overlayCtx.strokeRect(
          //  x * PIXEL_SIZE + 0.5,
          //  y * PIXEL_SIZE + 0.5,
          //  PIXEL_SIZE - 1,
          //  PIXEL_SIZE - 1
          //)
        }
      }
      return updatedData
    })
  }

  const overlayStrokeData = (canvasData: CanvasData, updatedStrokeData: boolean[][]) => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return

    const { canvas, brushColor, opacity } = canvasData
    const canvasCopy = canvas.map(row => [...row])

    for (let x = 0; x < GRID_SIZE; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        const strokeHere = updatedStrokeData[x][y]
        const currentColor = canvasCopy[x][y]
        const color = strokeHere ? blendColors(currentColor, brushColor, opacity) : currentColor
        ctx.fillStyle = color
        ctx.fillRect(x * PIXEL_SIZE, y * PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE)
        // update the canvas
        canvasCopy[x][y] = color
      }
    }

    return canvasCopy
  }

  const handlePalleteSelect = (brushColor: string) => {
    return () => setCanvasData((prev) => ({ ...prev, brushColor }))
  }

  const handleBrushSelect = (brushMap: string) => {
    return () => setCanvasData((prev) => ({ ...prev, brushMap }))
  }

  const handleOpacitySelect = (opacity: number) => {
    return () => setCanvasData((prev) => ({ ...prev, opacity }))
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
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
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
        {Object.entries(Opacities).map(([name, opacity]) =>
          <div
            key={name}
            style={{ height: 32, width: 32, backgroundColor: Colors.Red, opacity }}
            onClick={handleOpacitySelect(opacity)}
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
            onClick={handlePalleteSelect(color)}
          />
        )}
      </div>
    </>
  )
}

export default App
