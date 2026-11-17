import { describe, expect, it } from 'vitest';
import { ComparisonPresetReadError, instantiateComparisonPreset, loadComparisonPresets, removeComparisonPreset, saveComparisonPreset } from './comparisonPresets';
import type { ComparisonCheckSet } from './comparisonChecks';

const key='baudtide.comparison-presets.v1';
const set:ComparisonCheckSet={binding:{baselineField:'temperature',candidateField:'temperature',unit:'C'},checks:[{id:'old-check',metric:'mean',measure:'percent',operator:'lte',limit:1.0000001}]};
function memory(raw:string|null=null){let value=raw;return {getItem:(k:string)=>k===key?value:null,setItem:(k:string,v:string)=>{if(k===key)value=v;}};}

describe('comparison check presets',()=>{
  it('round-trips normalized names and independent definitions without measurement context',()=>{
    const storage=memory();expect(loadComparisonPresets(storage)).toEqual([]);
    const saved=saveComparisonPreset('  Firmware   limits  ',set,storage);
    expect(saved[0]).toMatchObject({name:'Firmware limits',checkSet:set});
    saved[0].checkSet.checks[0].limit=99;
    expect(loadComparisonPresets(storage)[0].checkSet.checks[0].limit).toBe(1.0000001);
    expect(Object.keys(saved[0]).sort()).toEqual(['checkSet','id','name']);
  });

  it('rejects duplicate names, invalid checks and invalid names without writing',()=>{
    const storage=memory();saveComparisonPreset('Bench A',set,storage);const before=storage.getItem(key);
    for(const name of ['', ' ', 'x'.repeat(49), 'bad\nname',' bench a '])expect(()=>saveComparisonPreset(name,set,storage)).toThrow();
    for(const checks of [[],Array(9).fill(set.checks[0]),[{...set.checks[0],limit:Infinity}],[{...set.checks[0],operator:'eq'}]])expect(()=>saveComparisonPreset('New',{...set,checks} as ComparisonCheckSet,storage)).toThrow();
    expect(storage.getItem(key)).toBe(before);
  });

  it('preserves corrupt, unsupported, oversized and duplicate data on every mutation',()=>{
    const row={id:'a',name:'Limits',checkSet:set};
    for(const raw of ['{broken','x'.repeat(400001),JSON.stringify({version:2,presets:[]}),JSON.stringify({version:1,presets:[null]}),JSON.stringify({version:1,presets:[row,row]}),JSON.stringify({version:1,presets:[row,{...row,id:'b',name:'limits'}]}),JSON.stringify({version:1,presets:[{...row,checkSet:{...set,checks:[]}}]})]){
      const storage=memory(raw);expect(()=>loadComparisonPresets(storage)).toThrow(ComparisonPresetReadError);
      expect(()=>saveComparisonPreset('New',set,storage)).toThrow('preserved');expect(()=>removeComparisonPreset('a',storage)).toThrow('preserved');expect(storage.getItem(key)).toBe(raw);
    }
    expect(()=>loadComparisonPresets({getItem:()=>{throw Error('denied');}})).toThrow(ComparisonPresetReadError);
  });

  it('bounds the library and mutates the latest stored library',()=>{
    const storage=memory();for(let i=0;i<24;i++)saveComparisonPreset(`Limits ${i}`,set,storage);
    expect(()=>saveComparisonPreset('Extra',set,storage)).toThrow('24');
    const first=loadComparisonPresets(storage)[0];expect(removeComparisonPreset(first.id,storage)).toHaveLength(23);
    const current=saveComparisonPreset('New',set,storage);expect(current).toHaveLength(24);expect(current.some(p=>p.id===first.id)).toBe(false);
  });

  it('reopens a full library with maximally escaped valid definitions',()=>{
    const storage=memory();const escaped:ComparisonCheckSet={binding:{baselineField:'\x01'.repeat(256),candidateField:'\x02'.repeat(256),unit:'\x03'.repeat(64)},checks:Array.from({length:8},(_,i)=>({...set.checks[0],id:String(i)+'\x04'.repeat(159)}))};
    for(let i=0;i<24;i++)saveComparisonPreset(String(i)+'"'.repeat(44),escaped,storage);
    expect(loadComparisonPresets(storage)).toHaveLength(24);
  });

  it('reports failed writes without changing saved data',()=>{
    const storage=memory();saveComparisonPreset('Limits',set,storage);const before=storage.getItem(key);
    const denied={getItem:storage.getItem,setItem:()=>{throw Error('quota');}};
    expect(()=>saveComparisonPreset('Another',set,denied)).toThrow('could not be saved');expect(()=>removeComparisonPreset(loadComparisonPresets(storage)[0].id,denied)).toThrow('could not be saved');expect(storage.getItem(key)).toBe(before);
  });

  it('applies independent fresh identities to explicitly selected signals with exact unit compatibility',()=>{
    const preset=saveComparisonPreset('Limits',set,memory())[0];let i=0;const binding={...set.binding,baselineField:'sensor A',candidateField:'sensor B'};
    const applied=instantiateComparisonPreset(preset,binding,()=>`new-${++i}`);
    expect(applied.binding).toEqual(binding);expect(applied.checks[0]).toEqual({...set.checks[0],id:'new-1'});
    applied.binding.unit='mutated';applied.checks[0].limit=99;expect(preset.checkSet).toEqual(set);expect(binding.unit).toBe('C');
    expect(()=>instantiateComparisonPreset(preset,{...binding,unit:'F'})).toThrow('units');
    expect(()=>instantiateComparisonPreset(preset,{...binding,baselineField:''})).toThrow();
    const unitless={...preset,checkSet:{...set,binding:{...set.binding,unit:''}}};expect(instantiateComparisonPreset(unitless,{...binding,unit:''}).binding.unit).toBe('');
  });
});
