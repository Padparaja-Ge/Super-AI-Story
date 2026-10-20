export function correctionRequest(kind:string,value:any,room:any,session:any):Record<string,unknown>;
export function roomManagementAccess(room:any,session:any,isHost:boolean):{pending:boolean;connected:boolean;canRead:boolean;canCorrect:boolean;canRestore:boolean};
