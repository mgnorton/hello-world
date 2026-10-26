// Shared procedural textures.
import * as THREE from 'three';

let glow: THREE.Texture | null = null;

/** Soft radial glow used for lights (runway lights, nav lights, strobes). */
export function getGlowTexture(): THREE.Texture {
  if (glow) return glow;
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d')!;
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  glow = new THREE.CanvasTexture(cv);
  return glow;
}
