import * as THREE from 'three';

export function createDroneMesh(mode = 'fpv') {
  const group = new THREE.Group();
  const bodyColor = mode === 'fpv' ? 0xef4444 : 0x38bdf8;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.12, 0.42),
    new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.6, roughness: 0.4 })
  );
  group.add(body);

  const armMat = new THREE.MeshStandardMaterial({ color: 0x1e293b });
  const rotorMat = new THREE.MeshBasicMaterial({ color: 0xcbd5e1, transparent: true, opacity: 0.7 });

  const offsets = [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]];
  for (const [ox, oz] of offsets) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, 0.04), armMat);
    arm.position.set(ox * 0.6, 0, oz * 0.6);
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 10), rotorMat);
    rotor.position.set(ox, 0.06, oz);
    group.add(arm, rotor);
  }
  return group;
}

export function applyDroneCamera(camera, drone) {
  const fx = -Math.sin(drone.yaw);
  const fz = -Math.cos(drone.yaw);

  camera.rotation.order = 'YXZ';
  camera.rotation.y = drone.yaw;
  camera.rotation.x = drone.pitch;
  camera.rotation.z = 0;

  if (drone.mode === 'fpv') {
    // 1st-Person FPV Attack Drone view
    camera.position.set(drone.x + fx * 0.25, drone.y + 0.05, drone.z + fz * 0.25);
  } else {
    // 3rd-Person Recon Overwatch Drone view
    camera.position.set(drone.x - fx * 3.5, drone.y + 1.4, drone.z - fz * 3.5);
  }
}
