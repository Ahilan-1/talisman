export async function mountLanding(root){
  const canvas=root?.querySelector('#landing-canvas');
  if(!canvas||matchMedia('(prefers-reduced-motion: reduce)').matches||navigator.connection?.saveData||innerWidth<700)return;
  try{
    const THREE=await import('./three.module.min.js');
    if(!canvas.isConnected)return;
    const renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:false,powerPreference:'low-power',failIfMajorPerformanceCaveat:true});
    const uniforms={time:{value:0},resolution:{value:new THREE.Vector2(1,1)}};
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,uniforms,vertexShader:'void main(){gl_Position=vec4(position.xy,0.,1.);}',fragmentShader:`precision mediump float;
      uniform float time; uniform vec2 resolution;
      void main(){
        vec2 uv=gl_FragCoord.xy/resolution;
        float drift=sin(time*.16+uv.y*4.0)*.035;
        float glow=exp(-length((uv-vec2(.79+drift,.46))*vec2(1.3,1.8))*3.5);
        float haze=exp(-length((uv-vec2(.33-drift,.72))*vec2(1.1,2.1))*4.0);
        vec3 colour=vec3(.96,.74,.57)*glow+vec3(.65,.72,.85)*haze;
        gl_FragColor=vec4(colour,clamp(glow*.22+haze*.12,0.,.3));
      }`});
    const scene=new THREE.Scene(),camera=new THREE.Camera(),mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);scene.add(mesh);
    const resize=()=>{const width=Math.max(1,Math.min(innerWidth,1200)),height=Math.max(1,Math.min(innerHeight,800));renderer.setSize(Math.round(width*.55),Math.round(height*.55),false);uniforms.resolution.value.set(renderer.domElement.width,renderer.domElement.height)};
    resize();addEventListener('resize',resize,{passive:true});
    let frame=0,last=0;const tick=now=>{if(!canvas.isConnected){removeEventListener('resize',resize);renderer.dispose();material.dispose();mesh.geometry.dispose();return}frame=requestAnimationFrame(tick);if(document.hidden||now-last<66)return;last=now;uniforms.time.value=now/1000;renderer.render(scene,camera)};
    frame=requestAnimationFrame(tick);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)renderer.clear()},{passive:true});
  }catch{ /* CSS atmosphere remains visible without WebGL. */ }
}
