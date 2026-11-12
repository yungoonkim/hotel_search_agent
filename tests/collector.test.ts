import { describe,it,expect,vi } from 'vitest';
import { TourApiCollector,parseResponse } from '../src/collector.js';
const body=(items:unknown,totalCount=1)=>({response:{header:{resultCode:'0000'},body:{items,totalCount}}});
const response=(data:unknown)=>Promise.resolve(new Response(JSON.stringify(data)));
describe('TourAPI mocked HTTP',()=>{
 it('normal response, singleton and empty lists',()=>{expect(parseResponse(body({item:{title:'a'}})).rows).toHaveLength(1);expect(parseResponse(body('')).rows).toEqual([]);expect(parseResponse(body({})).rows).toEqual([]);});
 it('rejects service errors and malformed responses',()=>{expect(()=>parseResponse({response:{header:{resultCode:'30'}}})).toThrow('TOUR_API_ERROR:30');expect(()=>parseResponse({})).toThrow();});
 it('requires key without sending HTTP',async()=>{const f=vi.fn();await expect(new TourApiCollector(undefined,{fetcher:f}).collect(1)).rejects.toThrow('KEY_MISSING');expect(f).not.toHaveBeenCalled();});
 it('fetches common, intro and paginated room details, uses new region code',async()=>{
 const fetcher=vi.fn(async(u:Parameters<typeof fetch>[0])=>{const url=new URL(String(u));if(url.pathname.endsWith('searchStay2')){expect(url.searchParams.get('lDongRegnCd')).toBe('26');return response(body({item:[{contentid:'1'}]}));}if(url.pathname.endsWith('detailInfo2'))return response(body({item:[{roomcode:url.searchParams.get('pageNo')}]},101));return response(body({item:{title:'sample'}}));});
 const data=await new TourApiCollector('test-key',{fetcher,delayMs:0}).collect(1); // pages of 1 item to totalCount 101
 expect(data.records[0]?.rooms).toHaveLength(101);expect(data.failures).toBe(0);
 });
 it('HTTP errors and network errors are redacted',async()=>{await expect(new TourApiCollector('secret',{delayMs:0,fetcher:async()=>new Response('',{status:429})}).collect(1)).rejects.toThrow('HTTP_429');await expect(new TourApiCollector('secret',{delayMs:0,fetcher:async()=>{throw Error('secret')}}).collect(1)).rejects.toThrow('CONNECTION_FAILED');});
 it('empty response and partial detail failure',async()=>{expect((await new TourApiCollector('key',{delayMs:0,fetcher:()=>response(body(''))}).collect(1)).records).toEqual([]);let n=0;const c=new TourApiCollector('key',{delayMs:0,fetcher:()=>++n===1?response(body({item:[{contentid:'1'}]})):Promise.resolve(new Response('',{status:500}))});expect((await c.collect(1)).failures).toBe(1);});
});
