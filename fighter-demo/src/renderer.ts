import { type Combat, type CombatEvent, type Fighter } from './combat'
import { type Transfer } from './ledger'
type Effect = { kind: 'hit' | 'block' | 'confirmed'; x: number; to: number; born: number; text: string; player: boolean }
const palette = { ink: '#10132d', blue: '#417aff', ice: '#a9e8ff', orange: '#ff8851', white: '#eff5ff' }
export class Renderer {
  private effects: Effect[] = []
  private shake = 0
  private readonly c: CanvasRenderingContext2D
  readonly reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  constructor(canvas: HTMLCanvasElement) { this.c = canvas.getContext('2d')!; this.c.imageSmoothingEnabled = false }
  event(event: CombatEvent) {
    if (event.kind === 'miss') return
    this.effects.push({ kind: event.kind, x: event.x, to: event.x, born: performance.now(), text: event.kind === 'block' ? 'BLOCK' : event.combo > 1 ? `${event.combo} HIT! · PENDING` : '0.05 PENDING', player: event.attacker === 'player' })
    if (event.kind === 'hit' && !this.reduced) this.shake = 5
  }
  confirm(tx: Transfer, game: Combat) {
    this.effects.push({ kind: 'confirmed', x: game.fighters[tx.victim].x, to: game.fighters[tx.attacker].x, born: performance.now(), text: `+0.05  ${tx.hash?.slice(2, 8)}`, player: tx.attacker === 'player' })
  }
  private rect(x: number, y: number, w: number, h: number, color: string) { this.c.fillStyle = color; this.c.fillRect(Math.round(x), Math.round(y), w, h) }
  private text(text: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'center') {
    this.c.font = `900 ${size}px monospace`; this.c.textAlign = align; this.c.fillStyle = palette.ink; this.c.fillText(text, x + 1, y + 2); this.c.fillStyle = color; this.c.fillText(text, x, y)
  }
  draw(game: Combat, now: number, attract: boolean) {
    const c = this.c
    c.save()
    const shake = this.shake
    this.shake = Math.max(0, shake - .6)
    c.translate(shake ? Math.round(Math.sin(now) * shake) : 0, 0)
    this.background(now)
    const p = game.fighters.player, b = game.fighters.bot
    this.fighter(attract ? { ...p, x: 156, move: 'idle' } : p, now)
    this.fighter(attract ? { ...b, x: 484, move: 'idle' } : b, now)
    if (!attract) {
      for (const f of [p, b]) if (f.combo > 2) this.text(`${f.combo} HIT COMBO`, f.x, 158, 10, f.side === 'player' ? '#9dc8ff' : '#ffc797')
    }
    this.effects = this.effects.filter(e => now - e.born < (e.kind === 'confirmed' ? 1_050 : 500))
    for (const e of this.effects) {
      const age = now - e.born
      const ratio = Math.min(1, age / 1_050)
      if (e.kind === 'confirmed') {
        const x = e.x + (e.to - e.x) * ratio
        const y = this.reduced ? 183 : 195 - Math.sin(ratio * Math.PI) * 67
        for (let i = 4; i >= 0; i--) this.rect(x + (e.player ? i * 6 : -i * 6), y + i * 2, 3, 3, i % 2 ? '#9eeec6' : '#d5fa99')
        this.rect(x - 6, y - 7, 12, 14, '#bc7d30'); this.rect(x - 4, y - 7, 8, 12, '#ffdf75'); this.rect(x - 1, y - 5, 2, 8, '#fff4bc')
        this.text(e.text, x, y - 15, 9, '#c5ffd7')
      } else {
        const r = Math.min(25, age / 10)
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4
          this.rect(e.x + Math.cos(a) * r, 215 + Math.sin(a) * r, age < 130 ? 5 : 2, 3, e.kind === 'block' ? '#b1eaff' : i % 2 ? '#ffb456' : '#fff5c4')
        }
        this.text(e.text, Math.max(65, Math.min(570, e.x)), 184 - age / 30, 9, e.kind === 'block' ? '#aedcff' : '#ffe3a4')
      }
    }
    // Delicate CRT scanlines, all artwork is drawn at this fixed low resolution.
    c.globalAlpha = .055
    for (let y = 0; y < 360; y += 3) this.rect(0, y, 640, 1, '#030818')
    c.globalAlpha = 1
    c.restore()
  }
  private background(now: number) {
    const c = this.c
    const sky = c.createLinearGradient(0, 0, 0, 290)
    sky.addColorStop(0, '#111831'); sky.addColorStop(.65, '#33345c'); sky.addColorStop(1, '#835574')
    c.fillStyle = sky; c.fillRect(0, 0, 640, 360)
    for (let i = 0; i < 60; i++) {
      const x = (i * 137 + 33) % 640, y = (i * 47 + 12) % 155
      this.rect(x, y, 1, i % 7 === 0 ? 2 : 1, i % 3 ? '#68718c' : '#c9bfcd')
    }
    // Pixel moon and layered skyline.
    this.rect(485, 73, 28, 38, '#aaa5c6'); this.rect(479, 80, 40, 24, '#aaa5c6'); this.rect(485, 89, 28, 4, '#83839e'); this.rect(495, 72, 16, 8, '#c7bdd1')
    for (let layer = 0; layer < 3; layer++) {
      for (let i = 0; i < 17; i++) {
        const x = i * 43 - layer * 17, height = 22 + ((i * 71 + layer * 31) % 85)
        const y = 227 - height + layer * 14
        this.rect(x, y, 35, height + 25, ['#343450', '#292e47', '#1e273d'][layer])
        this.rect(x + 7, y - 5, 20, 5, ['#343450', '#292e47', '#1e273d'][layer])
        if (i % 3 === 0) this.rect(x + 12, y - 18, 1, 14, '#4f536b')
        for (let wy = y + 10; wy < 243; wy += 12) for (let wx = 5; wx < 29; wx += 9) {
          if ((wy + wx + i) % 4 !== 0) this.rect(x + wx, wy, 3, 4, (i + wx) % 3 ? '#4a5977' : '#b1a177')
        }
      }
    }
    // Neon signs, roof machinery, air conditioning and overhead cables.
    this.rect(41, 147, 74, 37, '#141e38'); this.rect(39, 145, 78, 2, '#5987fe'); this.rect(39, 145, 2, 39, '#5987fe'); this.rect(115, 145, 2, 39, '#5987fe'); this.rect(39, 183, 78, 2, '#5987fe')
    this.text('BASE', 78, 171, 21, '#a4caff')
    this.rect(256, 139, 128, 31, '#191e34'); this.rect(255, 138, 130, 2, '#817aa3')
    this.text('BLOCK DISTRICT', 320, 152, 10, '#b4a0c4'); this.text('NATIVE SPEED · 200ms', 320, 163, 6, '#968fb0')
    this.rect(541, 171, 60, 26, '#3d435a'); this.rect(545, 174, 51, 2, '#697187')
    for (let i = 0; i < 7; i++) this.rect(547 + i * 7, 181, 3, 11, '#242d43')
    c.strokeStyle = '#131d31'; c.lineWidth = 2; c.beginPath(); c.moveTo(0, 122); c.quadraticCurveTo(270, 217, 640, 115); c.stroke()
    for (let i = 0; i < 13; i++) this.rect(i * 55, 126 + Math.sin(i / 12 * Math.PI) * 43, 3, 4, '#c5ba95')
    this.rect(0, 243, 640, 6, '#101b30'); this.rect(0, 243, 640, 2, '#7883a0')
    for (let i = 0; i < 16; i++) { this.rect(i * 43 + 10, 249, 3, 35, '#111e32'); this.rect(i * 43 + 13, 249, 1, 35, '#4b5675') }
    this.rect(0, 269, 640, 3, '#35435e')
    this.rect(0, 287, 640, 73, '#252f48'); this.rect(0, 287, 640, 3, '#7983a2'); this.rect(0, 290, 640, 3, '#141d34')
    for (let y = 300; y < 360; y += 18) this.rect(0, y, 640, 1, '#3f4963')
    for (let x = -160; x < 820; x += 80) {
      c.strokeStyle = '#414b65'; c.lineWidth = 1; c.beginPath(); c.moveTo(320 + (x - 320) * .65, 294); c.lineTo(x, 360); c.stroke()
    }
    this.rect(30, 314, 76, 4, '#586481'); this.rect(501, 314, 94, 4, '#586481')
    this.rect(260, 320, 120, 2, '#75809a'); this.text('B L O C K  F I G H T E R', 320, 341, 8, '#727e9a')
    this.rect(8, 283, 32, 8, '#1a253b'); this.rect(12, 270, 24, 15, '#3f4c68'); this.rect(15, 272, 18, 2, '#6d7992')
    // Tiny drifting rooftop particles (deterministic; never transaction claims).
    if (!this.reduced) for (let i = 0; i < 8; i++) this.rect((now / 70 + i * 91) % 640, 210 + (i * 13) % 70, 2, 1, '#8193ad')
  }
  private fighter(f: Fighter, now: number) {
    const c = this.c, blue = f.side === 'player', dir = blue ? 1 : -1
    const primary = blue ? '#3978ff' : '#f0824d', light = blue ? '#94c9ff' : '#ffcc91', dark = blue ? '#2342a4' : '#934b49'
    const skin = blue ? '#dba278' : '#b77d67', skinLight = blue ? '#f7cba0' : '#e6b297'
    const bob = f.move === 'idle' || f.move === 'block' ? Math.floor(Math.sin(now / 180) * 1.1) : 0
    this.rect(f.x - 26, 286, 52, 5, '#172137'); this.rect(f.x - 19, 284, 38, 2, '#172137')
    c.save(); c.translate(Math.round(f.x), 286 + bob); c.scale(dir * 2, 2)
    if (f.move === 'ko') { c.rotate(-Math.PI / 2); c.translate(5, 0) }
    if (f.move === 'hit') c.translate(-2, 0)
    const r = (x: number, y: number, w: number, h: number, color: string) => this.rect(x, y, w, h, color)
    const limb = (x: number, y: number, w: number, h: number, color: string, highlight: string) => { r(x - 1, y - 1, w + 2, h + 2, '#111a32'); r(x, y, w, h, color); r(x, y, 2, h - 1, highlight) }
    const stride = f.move === 'walk' ? Math.round(Math.sin(now / 65) * 4) : 0
    // Rear leg and arm silhouette.
    limb(-10 - stride, -19, 8, 16, dark, primary); limb(-12 - stride, -4, 11, 4, '#202b46', '#a9bed8')
    limb(-13, -37, 7, 14, dark, primary)
    // Torso: sleeveless technical gi, belt, individual pixels of piping.
    r(-10, -40, 20, 24, '#111a32'); r(-9, -39, 18, 21, primary); r(-8, -38, 4, 16, light); r(5, -36, 4, 17, dark)
    r(-4, -40, 9, 6, skin); r(-3, -37, 6, 3, skinLight); r(-2, -32, 4, 11, dark); r(-8, -20, 17, 3, '#e7e8dc'); r(3, -19, 3, 9, light)
    // Front leg / extended kick.
    if (f.move === 'kick') { limb(5, -22, 16, 8, primary, light); limb(19, -24, 12, 7, primary, light); limb(29, -25, 6, 9, '#202b46', '#d3dcec') }
    else { limb(3 + stride, -17, 8, 14, primary, light); limb(3 + stride, -4, 12, 4, '#202b46', '#d3dcec') }
    // Face, angular haircut, brow, bandana and two trailing ribbons.
    r(-8, -55, 16, 16, '#111a32'); r(-7, -54, 14, 14, skin); r(-4, -53, 11, 10, skinLight); r(7, -48, 2, 5, skinLight)
    r(-8, -56, 14, 5, '#1c233a'); r(-9, -53, 4, 6, '#1c233a'); r(-4, -58, 8, 3, '#1c233a'); r(2, -56, 7, 3, '#1c233a')
    r(-8, -51, 16, 3, blue ? '#eaf5fa' : '#7f3045'); r(-16, -50, 8, 2, light); r(-19, -48 + bob, 9, 2, primary)
    r(3, -47, 4, 2, '#29223b'); r(6, -47, 1, 1, '#fcffff'); r(3, -41, 4, 1, '#915b53')
    // Distinct active poses, including a bright defensive bracer.
    if (f.move === 'punch') {
      limb(8, -37, 20, 6, skin, skinLight); limb(26, -38, 9, 8, primary, light); r(17, -39, 11, 1, '#e6f3ff')
    } else if (f.move === 'block') {
      limb(9, -43, 7, 15, skin, skinLight); limb(9, -47, 9, 8, primary, light); r(19, -49, 2, 23, '#bce4ff'); r(21, -45, 1, 15, '#69a9ff')
    } else if (f.move === 'hit') {
      limb(8, -40, 7, 11, skin, skinLight); limb(12, -43, 8, 7, primary, light); r(-5, -47, 3, 2, '#fff1cf')
    } else {
      limb(8, -37, 7, 11, skin, skinLight); limb(12, -33, 8, 8, primary, light); r(12, -33, 8, 2, '#dbe7f7')
    }
    c.restore()
    this.rect(f.x - 3, 300, 6, 3, blue ? '#639fff' : '#fba76e')
    this.text(blue ? '01 / YOU' : '02 / BOT', f.x, 310, 7, blue ? '#a0c6ff' : '#eeb69c')
  }
}
