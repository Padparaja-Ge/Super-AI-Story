export const battlemapPreset={
  id:'zapper-sd21-1024',name:'D&D battlemaps 1024 v2.0 · Zapper',model:'dDBattlemaps_1024V20.ckpt',
  source:'https://civitai.com/models/23240/dandd-battlemaps?modelVersionId=191397',baseModel:'SD 2.1 768',
  positive:"(masterpiece, best quality, highres, ultra-detailed, 8k resolution:1.1), (top-down view:1.4), (bird's-eye view:1.3), (orthographic projection:1.2), flat 2d layout, tabletop rpg battlemap, dungeon map, game asset, empty environment, no characters, no miniatures, no creatures, clear layout, highly detailed textures, even lighting, distinct contrast, vivid colors, sharp focus, seamless design",
  negative:'(isometric:1.4), (3d:1.3), (perspective:1.3), angled view, diagonal view, tilt-shift, side view, first-person view, third-person view, characters, people, humans, monsters, npcs, creatures, miniatures, figures, tokens, statues, text, watermark, signature, username, blurry, noisy, messy, cluttered, distorted, warped, lowres, worst quality, bad quality, jpeg artifacts, oversaturated, dark shadows, unreadable layout',
  files:[
    {directory:'checkpoints',name:'dDBattlemaps_1024V20.ckpt',bytes:2607623129,sha256:'42bdf35d8fe791d78e37c17f7562ce6ed5119f5d1e362931c48dcc74e4e351a9',url:'https://civitai.com/api/download/models/191397?fileId=146346'},
    {directory:'checkpoints',name:'dDBattlemaps_1024V20.yaml',bytes:1816,sha256:'e1899dae2d0ac1f1f44915e2bff4dd94c4afc649f1166a09b798afa0af3ed5b1',url:'https://civitai.com/api/download/models/191397?fileId=146340'},
    {directory:'controlnet',name:'control_v11p_sd21_depth.safetensors',bytes:728494536,sha256:'ed33ec158b6ea3bf61494ee71adc16d45886d5f6611d108345a184ebe7d08d81',url:'https://huggingface.co/thibaud/controlnet-sd21/resolve/main/control_v11p_sd21_depth.safetensors'},
    {directory:'controlnet',name:'control_v11p_sd21_normalbae.safetensors',bytes:728494536,sha256:'b08c09d92e916a3b9cb4f89c74ccfacc296b4c82ca44b3d7427b3c76a92cc87d',url:'https://huggingface.co/thibaud/controlnet-sd21/resolve/main/control_v11p_sd21_normalbae.safetensors'}
  ]
};
export const battlemapWorkflow={
  '1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:battlemapPreset.model}},
  '2':{class_type:'CLIPTextEncode',inputs:{text:'{{prompt}}',clip:['1',1]},_meta:{title:'Positive'}},
  '3':{class_type:'CLIPTextEncode',inputs:{text:'{{negative_prompt}}',clip:['1',1]},_meta:{title:'Negative'}},
  '4':{class_type:'LoadImage',inputs:{image:'{{SAS_DEPTH}}'},_meta:{title:'SAS_DEPTH'}},
  '5':{class_type:'LoadImage',inputs:{image:'{{SAS_NORMAL}}'},_meta:{title:'SAS_NORMAL'}},
  '6':{class_type:'ControlNetLoader',inputs:{control_net_name:'control_v11p_sd21_depth.safetensors'}},
  '7':{class_type:'ControlNetLoader',inputs:{control_net_name:'control_v11p_sd21_normalbae.safetensors'}},
  '8':{class_type:'ControlNetApplyAdvanced',inputs:{positive:['2',0],negative:['3',0],control_net:['6',0],image:['4',0],strength:.6,start_percent:0,end_percent:.85}},
  '9':{class_type:'ControlNetApplyAdvanced',inputs:{positive:['8',0],negative:['8',1],control_net:['7',0],image:['5',0],strength:.2,start_percent:0,end_percent:.65}},
  '10':{class_type:'LoadImage',inputs:{image:'{{SAS_LAYOUT}}'},_meta:{title:'SAS_LAYOUT'}},
  '11':{class_type:'VAEEncode',inputs:{pixels:['10',0],vae:['1',2]}},
  '12':{class_type:'KSampler',inputs:{model:['1',0],positive:['9',0],negative:['9',1],latent_image:['11',0],seed:1,steps:32,cfg:7,sampler_name:'dpmpp_2m',scheduler:'karras',denoise:1}},
  '13':{class_type:'VAEDecode',inputs:{samples:['12',0],vae:['1',2]}},
  '14':{class_type:'SaveImage',inputs:{images:['18',0],filename_prefix:'SAS_battlemap'}},
  '15':{class_type:'LoadImage',inputs:{image:'{{SAS_WALL_MASK}}'},_meta:{title:'SAS_WALL_MASK'}},
  '16':{class_type:'ImageToMask',inputs:{image:['15',0],channel:'red'}},
  '17':{class_type:'EmptyImage',inputs:{width:1024,height:1024,batch_size:1,color:0}},
  '18':{class_type:'ImageCompositeMasked',inputs:{destination:['13',0],source:['17',0],mask:['16',0],x:0,y:0,resize_source:false},_meta:{title:'SAS_BLACK_WALLS'}}
};
export function mapComfyConfig(config){return {...config,baseUrl:config.mapBaseUrl?.trim()||config.baseUrl,model:config.mapModel||'',positivePrefix:config.mapPositivePrefix??battlemapPreset.positive,negative:config.mapNegative??battlemapPreset.negative};}
