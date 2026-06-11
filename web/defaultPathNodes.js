export const DEFAULT_PATH_NODE_LIBRARY = [
  {
    nodeType: "CheckpointLoaderSimple",
    comfyClass: "CheckpointLoaderSimple",
    modelType: "checkpoints",
    widgets: ["ckpt_name"],
  },
  {
    nodeType: "DiffusersLoader",
    comfyClass: "DiffusersLoader",
    modelType: "diffusers",
    widgets: ["model_path"],
  },
  {
    nodeType: "LoraLoader",
    comfyClass: "LoraLoader",
    modelType: "loras",
    widgets: ["lora_name"],
  },
  {
    nodeType: "LoraLoaderModelOnly",
    comfyClass: "LoraLoaderModelOnly",
    modelType: "loras",
    widgets: ["lora_name"],
  },
  {
    nodeType: "VAELoader",
    comfyClass: "VAELoader",
    modelType: "vae",
    widgets: ["vae_name"],
  },
  {
    nodeType: "ControlNetLoader",
    comfyClass: "ControlNetLoader",
    modelType: "controlnet",
    widgets: ["control_net_name"],
  },
  {
    nodeType: "UpscaleModelLoader",
    comfyClass: "UpscaleModelLoader",
    modelType: "upscale_models",
    widgets: ["model_name"],
  },
  {
    nodeType: "CLIPLoader",
    comfyClass: "CLIPLoader",
    modelType: "clips",
    widgets: ["clip_name"],
  },
  {
    nodeType: "DualCLIPLoader",
    comfyClass: "DualCLIPLoader",
    modelType: "clips",
    widgets: ["clip_name1", "clip_name2"],
  },
  {
    nodeType: "CLIPVisionLoader",
    comfyClass: "CLIPVisionLoader",
    modelType: "clips",
    widgets: ["clip_name"],
  },
];
