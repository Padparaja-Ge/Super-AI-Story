export function pipProgress(job: any): (chunk: string) => void;
export function installationProgress(job: any): {downloaded: number; total: number; label: string; weightsComplete: boolean};
