<template>
  <v-container style="max-width: 900px">
    <h1 class="text-headline-large my-6">教学管理使用指南</h1>
    <v-card v-for="section in sections" :key="section.title" variant="outlined" class="pa-6 my-4">
      <h2 class="text-title-large mb-4">{{ section.title }}</h2>
      <p v-for="text in section.text" :key="text" class="text-body-large mb-3">{{ text }}</p>
    </v-card>
    <v-btn :to="{name:'home'}" prepend-icon="mdi-arrow-left">返回工作台</v-btn>
  </v-container>
</template>
<script setup lang="ts">
const sections = [
 {title:'课程和名单',text:['侧栏的“课程”是唯一课程列表。管理员可在列表新建课程；进入具体课程后，使用“名单与课程设置”维护名单，教师使用“管理名单”。','超级管理员创建和维护课程名称、学期及负责教师。教师可查看既有课程，只能维护本人任课课程的学生和助教名单；助教只能参与指定课程教学。','HOJ 课程导入由超级管理员执行，刷新关联课程成员关系，保留作业、提交和成绩。管理中心名单修改不会反写 HOJ。']},
 {title:'用户',text:['超级管理员创建账号、调整角色、停用用户和重置密码；教师在“用户”中查找师生，不能修改账号和权限。','已有批量导入入口支持 XLSX 和 CSV。HOJ 导入账号仍通过 HOJ 登录，管理中心独立账号可使用本地登录。']},
 {title:'布置和提交作业',text:['进入课程，点击上方“布置作业”，进入“题库 → 我的题单”；自编、AI、导入和预置题目可加入同一选题篮组合成题单。设置题目权重，保存后选择课程及截止时间、允许的语言，审核布置为一次作业。一个课程可布置多次作业，每次作业可含多道题。','编程实验直接列在课程的“作业题单”中，通过上方“成绩与导出”查看和导出成绩。教师可在课程内编辑或实际删除作业；改动题面的已有提交会重判，删除题目会清理对应提交。已有文件作业保留提交与修改入口；课程存在文件作业时显示“文件作业成绩”。']},
 {title:'提交与成绩录入',text:['在作业提交列表查看已交与缺交学生。进入提交详情下载学生材料，直接填写分数并保存。教师和指定课程助教可评分，学生只能查看本人已公开的成绩。']},
 {title:'成绩统计与导出',text:['作业提交列表支持导出 XLSX 成绩表，包含学号、学生姓名、提交状态、评分状态和成绩。课程统计可查看整门课的成绩汇总、分布，并导出 CSV 或 XLSX。','学生提交材料支持原文件下载和批量归档下载。']},
];
</script>
<route lang="yaml">
name: user-guide
meta:
  title: 使用指南
  titleEn: User Guide
</route>
