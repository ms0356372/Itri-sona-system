import type {ParseProgress,ParsedHistoryFile} from './excel';

export async function parseHistoryFile(file:File,onProgress?:ParseProgress):Promise<ParsedHistoryFile>{
  const parser=await import('./excel');
  return parser.parseHistoryFile(file,onProgress);
}
