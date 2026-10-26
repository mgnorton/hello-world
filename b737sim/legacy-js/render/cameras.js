// Camera modes: cockpit, chase, orbit, tower, flyby and wing view.
import * as THREE from '../vendor/three.module.min.js';
import { clamp, DEG } from '../math.js';
import { B739 } from '../aircraftData.js';

export const CAMERA_MODES = ['cockpit', 'chase', 'orbit', 'tower', 'flyby', 'wing'];
const LABELS = { cockpit: 'Cockpit', chase: 'Chase', orbit: 'External', tower: 'Tower', flyby: 'Fly-by', wing: 'Wing' };

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.look = { yaw: 0, pitch: -6 * DEG };     // cockpit head look
    this.orbit = { yaw: 200 * DEG, pitch: 12 * DEG, dist: 75 };
    this.chase = { dist: 62, height: 13, yawOffset: 0 };
    this.smoothPos = null;
    this.smoothYaw = null;
    this.flybyPos = null;
    this.fov = 60;
    this.zoom = 1;
  }

  get label() {
    return LABELS[this.mode];
  }

  cycle(dir = 1) {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.set(CAMERA_MODES[(i + dir + CAMERA_MODES.length) % CAMERA_MODES.length]);
  }

  set(mode) {
    this.mode = mode;
    this.smoothPos = null;
    this.flybyPos = null;
    this.zoom = 1;
    if (mode === 'cockpit') this.look = { yaw: 0, pitch: -6 * DEG };
  }

  /** Mouse drag deltas in pixels. */
  drag(dx, dy) {
    if (this.mode === 'cockpit' || this.mode === 'wing') {
      this.look.yaw = clamp(this.look.yaw - dx * 0.004, -2.6, 2.6);
      this.look.pitch = clamp(this.look.pitch - dy * 0.004, -1.2, 1.2);
    } else if (this.mode === 'orbit') {
      this.orbit.yaw -= dx * 0.006;
      this.orbit.pitch = clamp(this.orbit.pitch + dy * 0.005, -0.25, 1.5);
    } else if (this.mode === 'chase') {
      this.chase.yawOffset -= dx * 0.006;
      this.chase.height = clamp(this.chase.height + dy * 0.1, -5, 60);
    }
  }

  wheel(delta) {
    const f = Math.exp(delta * 0.001);
    if (this.mode === 'orbit') this.orbit.dist = clamp(this.orbit.dist * f, 28, 600);
    else if (this.mode === 'chase') this.chase.dist = clamp(this.chase.dist * f, 35, 400);
    else this.zoom = clamp(this.zoom / f, 1, 8);
  }

  resetView() {
    this.look = { yaw: 0, pitch: -6 * DEG };
    this.chase.yawOffset = 0;
    this.chase.height = 13;
  }

  /** Keyboard look (cockpit) per frame. */
  keyLook(dx, dy, dt) {
    if (this.mode === 'cockpit') {
      this.look.yaw = clamp(this.look.yaw + dx * dt * 1.4, -2.6, 2.6);
      this.look.pitch = clamp(this.look.pitch + dy * dt * 1.0, -1.2, 1.2);
    } else if (this.mode === 'orbit') {
      this.orbit.yaw += dx * dt;
      this.orbit.pitch = clamp(this.orbit.pitch + dy * dt, -0.25, 1.5);
    }
  }

  update(ac, model, dt, towerPos, groundAt) {
    const cam = this.camera;
    const acPos = new THREE.Vector3(ac.pos[0], ac.pos[1], ac.pos[2]);
    const acQ = model.root.quaternion;
    let fov = 60;
    let near = 0.5;
    switch (this.mode) {
      case 'cockpit': {
        const eye = new THREE.Vector3(...B739.eyePoint).applyQuaternion(acQ).add(acPos);
        cam.position.copy(eye);
        // Head look relative to the aircraft: yaw about body up, pitch about body right.
        const q = acQ.clone()
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.look.yaw))
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.look.pitch));
        // Camera looks down -z; body forward is +x, so rotate -90 deg about y.
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2));
        cam.quaternion.copy(q);
        fov = 68;
        near = 0.05;
        break;
      }
      case 'wing': {
        const p = new THREE.Vector3(-7.5, 1.7, -11.5).applyQuaternion(acQ).add(acPos);
        cam.position.copy(p);
        const q = acQ.clone()
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.look.yaw - 0.32))
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.look.pitch - 0.05))
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2));
        cam.quaternion.copy(q);
        fov = 62;
        near = 0.1;
        break;
      }
      case 'chase': {
        // Follow the ground track direction with smoothing.
        const yaw = (ac.gs > 5 ? ac.track : ac.heading) * DEG + this.chase.yawOffset;
        if (this.smoothYaw === null) this.smoothYaw = yaw;
        let dy = yaw - this.smoothYaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.smoothYaw += dy * clamp(dt * 2.5, 0, 1);
        const back = new THREE.Vector3(-Math.sin(this.smoothYaw), 0, Math.cos(this.smoothYaw));
        const target = acPos.clone().add(back.multiplyScalar(this.chase.dist)).add(new THREE.Vector3(0, this.chase.height, 0));
        if (!this.smoothPos) this.smoothPos = target.clone();
        this.smoothPos.lerp(target, clamp(dt * 4, 0, 1));
        // Keep the vertical position tight so climbs don't leave the camera behind.
        this.smoothPos.y = target.y + (this.smoothPos.y - target.y) * 0.5;
        cam.position.copy(this.smoothPos);
        cam.lookAt(acPos.clone().add(new THREE.Vector3(0, 3, 0)));
        fov = 55;
        break;
      }
      case 'orbit': {
        const o = this.orbit;
        const off = new THREE.Vector3(
          Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist,
          Math.sin(o.pitch) * o.dist,
          Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist,
        );
        cam.position.copy(acPos).add(off);
        cam.lookAt(acPos);
        fov = 50;
        break;
      }
      case 'tower': {
        const tp = towerPos || acPos.clone().add(new THREE.Vector3(600, 80, 600));
        cam.position.copy(tp);
        cam.lookAt(acPos);
        const dist = tp.distanceTo(acPos);
        fov = clamp(2 * Math.atan(60 / dist) / DEG, 1.5, 60);
        break;
      }
      case 'flyby': {
        const vel = new THREE.Vector3(ac.vel[0], ac.vel[1], ac.vel[2]);
        const speed = vel.length();
        if (!this.flybyPos || this.flybyPos.distanceTo(acPos) > Math.max(900, speed * 12)) {
          const dir = speed > 3 ? vel.clone().normalize() : new THREE.Vector3(Math.sin(ac.heading * DEG), 0, -Math.cos(ac.heading * DEG));
          const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
          this.flybyPos = acPos.clone().add(dir.multiplyScalar(Math.max(250, speed * 7))).add(side.multiplyScalar(45)).add(new THREE.Vector3(0, 6, 0));
          const gh = groundAt ? groundAt(this.flybyPos.x, this.flybyPos.z) + 2 : -Infinity;
          if (this.flybyPos.y < gh) this.flybyPos.y = gh;
        }
        cam.position.copy(this.flybyPos);
        cam.lookAt(acPos);
        fov = clamp(2 * Math.atan(40 / this.flybyPos.distanceTo(acPos)) / DEG, 8, 70);
        break;
      }
      default:
    }
    // Never go below the ground.
    if (groundAt && this.mode !== 'cockpit' && this.mode !== 'wing') {
      const gh = groundAt(cam.position.x, cam.position.z) + 1.5;
      if (cam.position.y < gh) cam.position.y = gh;
    }
    fov /= this.zoom;
    if (Math.abs(cam.fov - fov) > 0.01 || cam.near !== near) {
      cam.fov = fov;
      cam.near = near;
      cam.updateProjectionMatrix();
    }
  }
}
