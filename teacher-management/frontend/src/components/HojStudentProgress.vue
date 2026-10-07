<template>
 <v-card variant="outlined" class="mt-4">
  <v-card-title class="d-flex align-center flex-wrap ga-2"><span>{{ text(`${data?.student.nick || studentId}的题单成绩`, `Problem set results: ${data?.student.nick || studentId}`) }}</span></v-card-title>
  <v-card-text>
   <p v-if="data" class="mb-3">{{ text('学号','Student number') }}：{{ data.student.student_no || data.student.user_id }}</p>
   <p class="mb-3 text-medium-emphasis">{{ text('每题按是否 AC 计分；通过得 100，未通过得 0。优先展示已通过的提交，同分取较新的代码。题单按题目权重计算总分。','Each problem scores 100 for AC and 0 otherwise. Passed submissions take priority; equal scores use the more recent code. Problem set totals use the assigned weights.') }}</p>
   <v-progress-linear v-if="loading" indeterminate/>
   <v-alert v-else-if="error" type="error" variant="tonal">{{ error }}<v-btn variant="text" @click="load">{{ text('重试','Retry') }}</v-btn></v-alert>
   <p v-else-if="!data?.batches.length">{{ text('本班暂无已发布的题单。','No published problem sets in this class.') }}</p>
   <v-expansion-panels v-else multiple v-model="opened">
    <v-expansion-panel v-for="batch in data.batches" :key="batch.batch_id" :value="batch.batch_id">
     <v-expansion-panel-title>{{ batch.title }} · {{ text(`成绩 ${batch.score} / 100`,`Score ${batch.score} / 100`) }}</v-expansion-panel-title>
     <v-expansion-panel-text><v-table><thead><tr><th>{{ text('题目','Problem') }}</th><th>{{ text('最好成绩','Best score') }}</th><th>{{ text('评测结果','Result') }}</th><th>{{ text('题单得分贡献','Weighted contribution') }}</th><th>{{ text('提交次数','Attempts') }}</th><th>{{ text('对应代码','Code') }}</th></tr></thead><tbody><tr v-for="p in batch.problems" :key="p.problem_id"><td>{{ p.title }}</td><td>{{ p.score===null?'—':`${p.score} / 100` }}</td><td>{{ p.label }}</td><td>{{ p.contribution }} / {{ batch.total_weight>0?Math.round(p.weight*10000/batch.total_weight)/100:0 }}</td><td>{{ p.attempts }}</td><td><v-btn v-if="p.submission_id" size="small" variant="text" @click="showCode(p)">{{ text('查看代码','View code') }}</v-btn><span v-else>—</span></td></tr></tbody></v-table></v-expansion-panel-text>
    </v-expansion-panel>
   </v-expansion-panels>
  </v-card-text>
 </v-card>
 <v-dialog v-model="codeOpen" max-width="1000"><v-card><v-card-title class="d-flex align-center flex-wrap ga-2"><span>{{ codeTitle }} · #{{ codeSid }}</span><v-spacer/><v-btn variant="text" @click="codeOpen=false">{{ text('关闭','Close') }}</v-btn></v-card-title><v-card-text><v-progress-linear v-if="codeLoading" indeterminate/><v-alert v-else-if="codeError" type="error">{{ codeError }}</v-alert><template v-else-if="code"><p class="mb-3">{{ code.result_label }} · {{ code.language_name }}</p><pre class="code-source">{{ code.code }}</pre></template></v-card-text></v-card></v-dialog>
</template>
<script setup lang="ts">
import {useI18n} from 'vue-i18n';
const props=defineProps<{offeringId:number;studentId:string;initialBatchId?:number}>();
const {locale}=useI18n();const text=(zh:string,en:string)=>locale.value==='en'?en:zh;
type Problem={problem_id:number;title:string;score:number|null;weight:number;contribution:number;submission_id:number|null;label:string;attempts:number};
type Progress={student:{user_id:string;nick:string;student_no:string};batches:{batch_id:number;title:string;score:number;total_weight:number;problems:Problem[]}[]};
const data=ref<Progress>();const loading=ref(false),error=ref(''),opened=ref<number[]>([]);
const codeOpen=ref(false),codeLoading=ref(false),codeError=ref(''),codeTitle=ref(''),codeSid=ref<number|null>(null),code=ref<{code:string;result_label:string;language_name:string}>();
let sequence=0,codeSequence=0;
async function request<T>(path:string):Promise<T>{const res=await fetch(path,{credentials:'same-origin'});const body=await res.json();if(!res.ok)throw Error(body.message||text('读取失败','Failed to load'));return body.data;}
async function load(){const seq=++sequence;++codeSequence;codeOpen.value=false;data.value=undefined;error.value='';loading.value=true;try{const result=await request<Progress>(`/api/offerings/${props.offeringId}/students/${encodeURIComponent(props.studentId)}/progress`);if(seq!==sequence)return;data.value=result;opened.value=result.batches.some(b=>b.batch_id===props.initialBatchId)?[props.initialBatchId!]:[];}catch(e){if(seq===sequence)error.value=e instanceof Error?e.message:String(e);}finally{if(seq===sequence)loading.value=false;}}
async function showCode(p:Problem){if(!p.submission_id)return;const seq=++codeSequence;codeSid.value=p.submission_id;codeTitle.value=p.title;code.value=undefined;codeError.value='';codeLoading.value=true;codeOpen.value=true;try{const result=await request<{code:string;result_label:string;language_name:string}>(`/api/submissions/${p.submission_id}/code`);if(seq===codeSequence)code.value=result;}catch(e){if(seq===codeSequence)codeError.value=e instanceof Error?e.message:String(e);}finally{if(seq===codeSequence)codeLoading.value=false;}}
watch(()=>[props.offeringId,props.studentId,props.initialBatchId],load,{immediate:true});
onUnmounted(()=>{++sequence;++codeSequence;});
</script>
<style scoped>.code-source{white-space:pre;overflow:auto;max-height:65vh;padding:16px;border:1px solid rgba(var(--v-border-color),var(--v-border-opacity));font-family:monospace;tab-size:4}</style>
