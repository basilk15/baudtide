(()=>{
  'use strict';
  const boot=()=>{
  const root=document.querySelector('[data-mobile-telemetry]');
  if(!root)return;
  const fieldsEl=root.querySelector('[data-telemetry-fields]');
  const chartEl=root.querySelector('[data-telemetry-chart]');
  const lineEl=root.querySelector('[data-telemetry-line]');
  const areaEl=root.querySelector('[data-telemetry-area]');
  const pointEl=root.querySelector('[data-telemetry-point]');
  const emptyEl=root.querySelector('[data-telemetry-empty]');
  const stateEl=root.querySelector('[data-telemetry-state]');
  const stateTextEl=root.querySelector('[data-telemetry-state-text]');
  const currentEl=root.querySelector('[data-telemetry-current]');
  const unitEl=root.querySelector('[data-telemetry-unit]');
  const signalCountEl=root.querySelector('[data-telemetry-signal-count]');
  const sampleCountEl=root.querySelector('[data-telemetry-sample-count]');
  const rangeEl=root.querySelector('[data-telemetry-range]');
  const axisTopEl=root.querySelector('[data-telemetry-axis-top]');
  const axisBottomEl=root.querySelector('[data-telemetry-axis-bottom]');
  const axisLeftEl=root.querySelector('[data-telemetry-axis-left]');
  const axisRightEl=root.querySelector('[data-telemetry-axis-right]');
  const pauseEl=root.querySelector('[data-telemetry-pause]');
  const chartLabel='Mobile telemetry chart';
  const MAX_SAMPLES=180;
  const MAX_FIELDS=32;
  const MAX_LINE_LENGTH=16*1024;
  const NUMBER_SOURCE='[+-]?(?:(?:\\d+\\.\\d*)|(?:\\d*\\.\\d+)|\\d+)(?:[eE][+-]?\\d+)?';
  const NUMBER_PATTERN=new RegExp('^'+NUMBER_SOURCE+'$');
  const NUMBER_WITH_UNIT_PATTERN=new RegExp('^('+NUMBER_SOURCE+')\\s*(%|[A-Za-zµμ°][A-Za-z0-9µμ°/*^._-]{0,23})?$','u');
  const PAIR_PATTERN=new RegExp('(?:^|[,;|\\s])\\s*([A-Za-z_][A-Za-z0-9_.-]{0,63})\\s*(?:=|:)\\s*('+NUMBER_SOURCE+')\\s*(%|[A-Za-zµμ°][A-Za-z0-9µμ°/*^._-]{0,23})?(?=$|[,;|\\s])','gu');
  const HEADER_UNIT_PATTERN=/^(.*?)\s*(?:\(([^()]+)\)|\[([^\[\]]+)\])\s*$/u;
  const BATCH_KEYS=new Set(['data','measurements','readings','samples','telemetry']);
  const streams=new Map();
  let activeStreamId=window.baudtideMobileSelectedSessionId||'single';
  let activeFieldKey='';
  let chartPaused=false;
  let renderPending=false;

  function isRecord(value){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value)}
  function own(value,key){return Object.prototype.hasOwnProperty.call(value,key)}
  function normalizeUnit(value){const unit=typeof value==='string'?value.trim():'';return unit||undefined}
  function finiteNumber(value){if(typeof value!=='string'||!NUMBER_PATTERN.test(value.trim()))return null;const parsed=Number(value);return Number.isFinite(parsed)?parsed:null}
  function numericValue(value){
    if(typeof value==='number')return Number.isFinite(value)?{value}:null;
    if(typeof value!=='string')return null;
    const match=value.trim().match(NUMBER_WITH_UNIT_PATTERN);
    if(!match)return null;
    const parsed=Number(match[1]);
    return Number.isFinite(parsed)?{value:parsed,unit:normalizeUnit(match[2])}:null;
  }
  function schemaId(values){return Object.keys(values).sort().map(key=>key+'='+String(values[key].unit||'')).join('|')}
  function measurementValue(value){
    if(!isRecord(value))return null;
    const parsed=numericValue(value.value??value.reading??value.val);
    if(!parsed)return null;
    const explicit=typeof value.unit==='string'?value.unit:typeof value.units==='string'?value.units:undefined;
    return explicit===undefined?parsed:{value:parsed.value,unit:normalizeUnit(explicit)};
  }
  function flattenJson(value){
    const values=Object.create(null);
    let invalid=false;
    const flatten=(current,path,depth)=>{
      if(invalid||depth>16){invalid=true;return}
      const scalar=numericValue(current);
      if(scalar){
        if(!path||own(values,path)||Object.keys(values).length>=64){invalid=true;return}
        values[path]=scalar;return;
      }
      if(Array.isArray(current)){
        current.forEach((child,index)=>flatten(child,path?path+'.'+index:String(index),depth+1));return;
      }
      if(!isRecord(current))return;
      if(path){
        const measurement=measurementValue(current);
        if(measurement){
          if(own(values,path)||Object.keys(values).length>=64){invalid=true;return}
          values[path]=measurement;return;
        }
      }
      Object.entries(current).forEach(([key,child])=>{
        const segment=key.trim();
        if(!segment||segment.length>80){invalid=true;return}
        flatten(child,path?path+'.'+segment:segment,depth+1);
      });
    };
    flatten(value,'',0);
    return invalid||!Object.keys(values).length?null:{format:'json',schemaId:'json:'+schemaId(values),values};
  }
  function balancedJsonEnd(line,start){
    const opening=line[start];
    if(opening!=='{'&&opening!=='[')return null;
    const stack=[opening];let inString=false;let escaped=false;
    for(let index=start+1;index<line.length;index+=1){
      const character=line[index];
      if(inString){if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character==='"')inString=false;continue}
      if(character==='"'){inString=true;continue}
      if(character==='{'||character==='['){stack.push(character);continue}
      if(character!=='}'&&character!==']')continue;
      const expected=character==='}'?'{':'[';
      if(stack.pop()!==expected)return null;
      if(!stack.length)return index+1;
    }
    return null;
  }
  function jsonCandidates(line){
    const trimmed=line.trim();
    try{return {matched:true,values:[JSON.parse(trimmed)]}}catch{}
    const values=[];let matched=false;
    for(let start=0;start<line.length;start+=1){
      if(line[start]!=='{'&&line[start]!=='[')continue;
      const end=balancedJsonEnd(line,start);if(end===null)continue;
      try{values.push(JSON.parse(line.slice(start,end)));matched=true;start=end-1}catch{}
    }
    return {matched,values};
  }
  function jsonRecords(value){
    if(Array.isArray(value))return value.filter(isRecord);
    if(!isRecord(value))return [];
    for(const [key,child] of Object.entries(value))if(BATCH_KEYS.has(key.toLowerCase())&&Array.isArray(child)&&child.some(isRecord))return child.filter(isRecord);
    return [value];
  }
  function parseJson(line){
    const candidates=jsonCandidates(line);
    const records=candidates.values.flatMap(value=>jsonRecords(value).map(flattenJson).filter(Boolean));
    return {matched:candidates.matched,records};
  }
  function parsePairs(line){
    const values=Object.create(null);let match;PAIR_PATTERN.lastIndex=0;
    while((match=PAIR_PATTERN.exec(line))!==null){
      if(Object.keys(values).length>=64)return null;
      const value=finiteNumber(match[2]);if(value===null||own(values,match[1]))return null;
      values[match[1]]={value,unit:normalizeUnit(match[3])};
    }
    return Object.keys(values).length?{format:'pairs',schemaId:'pairs:'+schemaId(values),values}:null;
  }
  function delimitedCells(line,delimiter){
    const cells=[];let cell='';let quoted=false;
    for(let index=0;index<line.length;index+=1){
      const character=line[index];
      if(quoted){if(character==='"'){if(line[index+1]==='"'){cell+='"';index+=1}else quoted=false}else cell+=character;continue}
      if(character==='"'){if(cell)return null;quoted=true}
      else if(character===delimiter){cells.push(cell.trim());cell=''}
      else cell+=character;
    }
    if(quoted)return null;cells.push(cell.trim());return cells;
  }
  function headerField(cell){
    if(!cell||cell.length>80||/[\r\n\u0000-\u001F]/u.test(cell))return null;
    const match=cell.match(HEADER_UNIT_PATTERN);const key=(match?.[1]||cell).trim();
    if(!key||key.length>64)return null;
    return {key,unit:normalizeUnit(match?.[2]||match?.[3])};
  }
  function parseHeader(line){
    const delimiter=line.includes('\t')?'\t':line.includes(',')?',':null;if(!delimiter)return null;
    const cells=delimitedCells(line,delimiter);if(!cells||cells.length<2||cells.length>64)return null;
    const fields=cells.map(headerField);
    if(fields.some(field=>!field||!/[A-Za-z]/u.test(field.key))||new Set(fields.map(field=>field.key)).size!==fields.length)return null;
    return {delimiter,fields};
  }
  function parseRecord(line,header){
    const cells=delimitedCells(line,header.delimiter);if(!cells||cells.length!==header.fields.length)return null;
    const values=Object.create(null);
    cells.forEach((cell,index)=>{const value=finiteNumber(cell);if(value!==null)values[header.fields[index].key]={value,unit:header.fields[index].unit}});
    if(!Object.keys(values).length)return null;
    const format=header.delimiter===','?'csv':'tsv';return {format,schemaId:format+':'+schemaId(values),values};
  }
  class LineAssembler{
    constructor(){this.current='';this.skipLf=false}
    push(text){
      const lines=[];if(typeof text!=='string')return lines;let start=0;
      const add=segment=>{if(this.current.length+segment.length<=MAX_LINE_LENGTH)this.current+=segment;else this.current=''};
      for(let index=0;index<text.length;index+=1){
        const character=text[index];
        if(this.skipLf){this.skipLf=false;if(character==='\n'){start=index+1;continue}}
        if(character!=='\r'&&character!=='\n')continue;
        add(text.slice(start,index));lines.push(this.current);this.current='';if(character==='\r')this.skipLf=true;start=index+1;
      }
      add(text.slice(start));return lines;
    }
  }
  class TelemetryParser{
    constructor(){this.assembler=new LineAssembler();this.header=null;this.pending=new Map();this.detected=new Set()}
    push(text,metadata){
      const output=[];
      this.assembler.push(text).forEach((line,lineIndex)=>{
        const json=parseJson(line);let records=json.records;
        if(!json.matched){const pairs=parsePairs(line);records=pairs?[pairs]:[]}
        if(json.matched&&!records.length)records=[];
        if(!json.matched&&!records.length){const header=parseHeader(line);if(header){this.header=header;return}const delimited=this.header?parseRecord(line,this.header):null;if(delimited)records=[delimited]}
        records.forEach(record=>{
          const metadataWithIndex={...metadata,sequence:(metadata.sequence||0)*1000+lineIndex};
          if(this.detected.has(record.schemaId)){output.push({...metadataWithIndex,...record});return}
          const pending=this.pending.get(record.schemaId)||[];pending.push({...metadataWithIndex,...record});this.pending.set(record.schemaId,pending);
          if(pending.length<2)return;
          this.pending.delete(record.schemaId);this.detected.add(record.schemaId);output.push(...pending);
        });
      });
      return output;
    }
  }
  function streamState(id){
    const key=id||'single';let state=streams.get(key);
    if(state)return state;
    state={parser:new TelemetryParser(),fields:new Map(),sampleCount:0,lastTimestamp:''};streams.set(key,state);return state;
  }
  function formatNumber(value){
    if(!Number.isFinite(value))return '—';
    const absolute=Math.abs(value);
    if((absolute&&absolute<.0001)||absolute>=10000000)return value.toExponential(3);
    return new Intl.NumberFormat(undefined,{maximumFractionDigits:5}).format(value);
  }
  function displayKey(key){return key.length>28?key.slice(0,26)+'…':key}
  function activeState(){return streamState(activeStreamId)}
  function setStatus(label,state){stateEl.dataset.state=state;stateTextEl.textContent=label}
  function addRecord(state,record){
    state.sampleCount+=1;state.lastTimestamp=record.timestamp||new Date().toISOString();
    Object.entries(record.values||{}).forEach(([key,value])=>{
      let field=state.fields.get(key);
      if(!field){if(state.fields.size>=MAX_FIELDS)return;field={key,unit:value.unit||'',samples:[],latest:value.value};state.fields.set(key,field)}
      if(!field.unit&&value.unit)field.unit=value.unit;field.latest=value.value;field.samples.push({value:value.value,timestamp:record.timestamp||'',sequence:record.sequence||0});
      if(field.samples.length>MAX_SAMPLES)field.samples.splice(0,field.samples.length-MAX_SAMPLES);
    });
  }
  function renderFields(state){
    fieldsEl.replaceChildren();
    const fields=[...state.fields.values()];signalCountEl.textContent=fields.length+' signal'+(fields.length===1?'':'s');sampleCountEl.textContent=state.sampleCount+' sample'+(state.sampleCount===1?'':'s');
    if(!fields.length){activeFieldKey='';const hint=document.createElement('span');hint.className='bt-mobile-telemetry-fields-hint';hint.textContent='Waiting for signal fields';fieldsEl.append(hint);return}
    if(!activeFieldKey||!state.fields.has(activeFieldKey))activeFieldKey=fields[0].key;
    fields.forEach(field=>{
      const button=document.createElement('button');button.type='button';button.className='bt-mobile-telemetry-field';button.setAttribute('role','tab');button.setAttribute('aria-selected',String(field.key===activeFieldKey));button.setAttribute('aria-label','Show '+field.key+' graph');
      const dot=document.createElement('i');dot.setAttribute('aria-hidden','true');const name=document.createElement('span');name.textContent=displayKey(field.key);const current=document.createElement('small');current.textContent=formatNumber(field.latest)+(field.unit?' '+field.unit:'');button.append(dot,name,current);
      button.onclick=()=>{activeFieldKey=field.key;render()};fieldsEl.append(button);
    });
  }
  function renderChart(state){
    const field=state.fields.get(activeFieldKey);const samples=field?.samples.slice(-90)||[];
    if(!field||!samples.length){lineEl.setAttribute('d','');areaEl.setAttribute('d','');pointEl.setAttribute('cx','0');pointEl.setAttribute('cy','0');pointEl.setAttribute('r','0');emptyEl.hidden=false;emptyEl.querySelector('strong').textContent=state.fields.size?'Select a signal to draw its trace':'Waiting for repeated numeric records';emptyEl.querySelector('span').textContent=state.fields.size?'Choose a signal above. Each graph keeps the latest bounded samples.':'Send repeated JSON, key/value, or header-based CSV/TSV records to populate the phone chart.';currentEl.textContent='—';unitEl.textContent='No plotted signal yet';rangeEl.textContent='No range yet';axisTopEl.textContent='—';axisBottomEl.textContent='—';axisLeftEl.textContent='—';axisRightEl.textContent='—';return}
    emptyEl.hidden=true;const values=samples.map(item=>item.value);let min=Math.min(...values);let max=Math.max(...values);if(min===max){const pad=Math.max(Math.abs(min)*.05,.5);min-=pad;max+=pad}else{const pad=(max-min)*.12;min-=pad;max+=pad}
    const left=48,right=622,top=20,bottom=202,width=right-left,height=bottom-top;const x=index=>samples.length===1?(left+right)/2:left+(index/(samples.length-1))*width;const y=value=>bottom-((value-min)/(max-min))*height;
    const points=samples.map((item,index)=>`${x(index).toFixed(1)},${y(item.value).toFixed(1)}`);const line='M '+points.join(' L ');const area=`M ${left} ${bottom} L ${points.join(' L ')} L ${right} ${bottom} Z`;lineEl.setAttribute('d',line);areaEl.setAttribute('d',area);const last=samples[samples.length-1];pointEl.setAttribute('cx',x(samples.length-1).toFixed(1));pointEl.setAttribute('cy',y(last.value).toFixed(1));pointEl.setAttribute('r','4');
    axisTopEl.textContent=formatNumber(max);axisBottomEl.textContent=formatNumber(min);axisLeftEl.textContent=formatNumber(samples[0].value);axisRightEl.textContent=formatNumber(last.value);currentEl.textContent=formatNumber(last.value);unitEl.textContent=field.key+(field.unit?' · '+field.unit:'');rangeEl.textContent='Range '+formatNumber(Math.min(...values))+'–'+formatNumber(Math.max(...values));chartEl.setAttribute('aria-label',chartLabel+' for '+field.key+', latest value '+formatNumber(last.value)+(field.unit?' '+field.unit:''));
  }
  function render(){
    renderPending=false;const state=activeState();renderFields(state);renderChart(state);if(chartPaused){setStatus('Paused','paused')}else if(state.fields.size){setStatus('Live traces','live')}else setStatus('Listening','empty');
  }
  function requestRender(){if(chartPaused||renderPending)return;renderPending=true;if(window.requestAnimationFrame)window.requestAnimationFrame(render);else window.setTimeout(render,0)}
  function push(event){
    if(!event||typeof event.text!=='string')return;
    if(activeStreamId==='single'&&event.sessionId)activeStreamId=event.sessionId;
    const id=event.sessionId||'single';const state=streamState(id);const records=state.parser.push(event.text,{timestamp:event.timestamp||new Date().toISOString(),sequence:Number.isSafeInteger(event.sequence)?event.sequence:state.sampleCount+1});
    if(!records.length)return;records.forEach(record=>addRecord(state,record));if(id===activeStreamId)requestRender();
  }
  function setStream(id){activeStreamId=id||'single';activeFieldKey='';render()}
  pauseEl.onclick=()=>{chartPaused=!chartPaused;pauseEl.textContent=chartPaused?'Resume chart':'Pause chart';pauseEl.setAttribute('aria-pressed',String(chartPaused));if(!chartPaused)render();else setStatus('Paused','paused')};
  window.baudtideTelemetry={push,setStream};
  render();
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
