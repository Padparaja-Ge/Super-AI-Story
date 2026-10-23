import {createRoot} from 'react-dom/client';
import {AdventureRoster} from '../../src/AdventureTable';
const qa=window as any,root=createRoot(document.getElementById('root')!);
qa.checkActions=[];
qa.renderAdventure=()=>root.render(<AdventureRoster game={qa.game} selfId="host" host={true} actorId={qa.selectedActor||'host'} setActorId={(id:string)=>{qa.selectedActor=id;qa.renderAdventure();}} disabled={!!qa.locked} act={(value:any)=>{qa.checkActions.push(value);return qa.delayAction?new Promise(resolve=>{qa.finishAction=resolve;}):Promise.resolve(true);}}/>);
qa.adventureReady=true;
