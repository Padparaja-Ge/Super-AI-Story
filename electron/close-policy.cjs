async function confirmManualClose({getStatus,save,choose}){
  const status=await getStatus();
  if(status?.enabled!==false||status?.dirty!==true)return true;
  const choice=await choose();
  if(choice==='save'){await save();return true;}
  return choice==='discard';
}
module.exports={confirmManualClose};
