import { expect, it } from 'vitest';
import { captureInventoryCsv } from './captureInventory';
import type { SavedLog } from '../serial/serial';
it('exports filtered rows in order, escapes notes, and protects spreadsheet cells',()=>{
  const logs=[{path:'/private/a',sessionName:'=1+1',fileName:'a.log',sizeBytes:42,state:'saved',modifiedAt:'2026-01-01'}, {path:'/private/b',sessionName:'Beta',fileName:'b.log',sizeBytes:9,state:'interrupted',modifiedAt:'2026-01-02'}] as SavedLog[];
  const csv=captureInventoryCsv(logs,{'/private/a':{title:'Thermal, "A"',notes:'line 1\nline 2'}},{'/private/a':{favorite:true,tags:['baseline']}});
  expect(csv).toContain('"Thermal, ""A"""');
  expect(csv).toContain('"line 1\nline 2"');
  expect(csv).toContain("'=1+1");
  expect(csv).toContain('baseline');
  expect(csv).not.toContain('/private/');
  expect(csv.indexOf('Thermal')).toBeLessThan(csv.indexOf('Beta'));
});
it('neutralizes formulas after whitespace and exports an empty inventory with headers',()=>{
  const csv=captureInventoryCsv([{sessionName:' \t@SUM(1)',fileName:'a',path:'/a',sizeBytes:0,state:'saved'}] as SavedLog[],{},{});
  expect(csv).toContain("' \t@SUM(1)");
  expect(captureInventoryCsv([],{},{}).trim().split('\n')).toHaveLength(1);
});
