import {type Message,type StoryImage} from './types';
export function storyTimeline(messages:Message[],images:StoryImage[]){
  return [...messages.map((message,index)=>({type:'message' as const,id:message.id,at:Date.parse(message.createdAt)||0,message,index})),...images.map(image=>({type:'image' as const,id:image.id,at:Date.parse(image.createdAt)||0,image}))].sort((a,b)=>a.at-b.at);
}
