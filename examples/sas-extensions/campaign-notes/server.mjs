export function activate(sas) {
  sas.route('get','/status',async(req,res)=>res.json({id:sas.id,apiVersion:sas.apiVersion}));
  // This is a style instruction, not the player's stored private notes.
  sas.onPrompt(()=> 'Подтверждённые результаты движка неизменны; передай их в повествовании без повторного расчёта.',{modes:['dnd','custom']});
}
