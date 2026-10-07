<template>
  <v-container>
    <TopNavigation :items="[
      {title:text('课程列表','Courses'),to:{name:'courses-list'}},
      {title:courseTitle || text('班级','Class'),to:backRoute},
      {title:text('学生成绩与代码','Student results & code')},
    ]"/>
    <div class="d-flex align-center flex-wrap ga-3 my-4">
      <h2 class="text-headline-medium font-weight-light">{{ text('学生成绩与代码','Student results & code') }}</h2>
      <v-spacer/>
      <v-btn :to="backRoute" prepend-icon="mdi-arrow-left" variant="outlined">{{ text('返回学生名单','Back to students') }}</v-btn>
    </div>
    <v-progress-linear v-if="loading" indeterminate/>
    <v-alert v-else-if="error" type="error" variant="tonal">{{ error }}<v-btn variant="text" @click="load">{{ text('重试','Retry') }}</v-btn></v-alert>
    <HojStudentProgress v-else-if="offeringId" :offering-id="offeringId" :student-id="props.studentId" :initial-batch-id="initialBatchId"/>
  </v-container>
</template>

<script setup lang="ts">
import { instance as api } from '@/api/axiosInstance';
import { useI18n } from 'vue-i18n';
const props=defineProps<{courseId:string;studentId:string}>();
const route=useRoute();
const initialBatchId=computed(()=>typeof route.query.studentBatch==='string' && /^\d+$/.test(route.query.studentBatch) ? Number(route.query.studentBatch) : undefined);
const {locale}=useI18n();
const text=(zh:string,en:string)=>locale.value==='en'?en:zh;
const backRoute=computed(()=>({path:`/courses/${props.courseId}`,query:route.query,hash:'#students'}));
const offeringId=ref<number>(),courseTitle=ref(''),loading=ref(false),error=ref('');
let sequence=0;
async function load(){
  const current=++sequence;loading.value=true;error.value='';offeringId.value=undefined;courseTitle.value='';
  try{
    const links:{course_id:number;offering_id:number}[]=(await api.get('/api/hoj/links')).data;
    const link=links.find(item=>item.course_id===Number(props.courseId));
    if(!link)throw Error(text('班级不存在或您无权访问。','Class not found or access denied.'));
    const response=await fetch(`/api/offerings/${link.offering_id}?include_insights=false`,{credentials:'same-origin'});
    const body=await response.json();
    if(!response.ok)throw Error(body.message||text('班级暂时无法加载','Class unavailable'));
    if(current!==sequence)return;
    if(body.data.offering.role!=='teacher')throw Error(text('只有本班教师可以查看学生成绩与代码。','Only this class’s teachers can view student results and code.'));
    courseTitle.value=body.data.offering.title;offeringId.value=link.offering_id;
  }catch(e){if(current===sequence)error.value=e instanceof Error?e.message:String(e);}
  finally{if(current===sequence)loading.value=false;}
}
watch(()=>props.courseId,load,{immediate:true});
onUnmounted(()=>{++sequence;});
</script>

<route lang="yaml">
name: course-student-progress
props: true
meta:
  title: 学生成绩与代码
  titleEn: Student results & code
</route>
