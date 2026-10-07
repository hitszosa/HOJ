<template>
  <v-dialog v-model="model" max-width="800" persistent @keydown.esc.stop.prevent="model = false">
    <v-card class="px-2 pt-2" prepend-icon="mdi-account-multiple-plus" title="Excel 导入名单">
      <v-card-text>
        <p>第一行填写“学号、姓名”，每行一位学生，默认角色为学生。学号请设为文本，保留前导零。</p>
        <p class="mt-2">也兼容“用户名、姓名、角色”三列；角色可填“学生”或“教师”。不要求固定工作表名。</p>
        <p class="mt-2 text-medium-emphasis">这里创建用户账号；导入后，进入对应课程，通过“名单与课程设置”将学生加入课程。</p>
        <v-file-input v-model="file" accept=".xlsx,.xltx,.xls,.ods,.csv" class="mt-4" label="选择 Excel / CSV 名单" :disabled="pending" />
        <v-alert v-if="message" :type="messageType" variant="tonal" class="mb-4" style="white-space: pre-wrap">{{ message }}</v-alert>
        <div v-if="users.length" class="mb-4">
          <p role="status">已读取 {{ users.length }} 位用户（工作表：{{ sheetName }}）<span v-if="skippedDuplicates">，合并了 {{ skippedDuplicates }} 行重复记录</span>。预览前 5 行：</p>
          <v-table density="compact">
            <thead><tr><th>学号 / 用户名</th><th>姓名</th><th>角色</th></tr></thead>
            <tbody><tr v-for="user in users.slice(0, 5)" :key="user.username"><td>{{ user.username }}</td><td>{{ user.real_name }}</td><td>{{ roleName(user.role) }}</td></tr></tbody>
          </v-table>
        </div>
        <v-select label="对于系统中已存在的用户名" v-model="existingUserOption" :disabled="pending" :items="[{ title: '忽略（保留原账号与密码）', value: 'ignore' }, { title: '覆盖信息并重置管理中心密码', value: 'overwrite' }, { title: '报错并停止导入', value: 'error' }]" />
      </v-card-text>
      <v-card-actions class="py-5 pr-5">
        <v-btn href="/management/student-roster-template.xlsx" download>下载两列 Excel 模板</v-btn>
        <v-spacer />
        <v-btn @click="model = false" :disabled="pending">关闭</v-btn>
        <v-btn variant="tonal" color="primary" @click="batchCreateUsers" :disabled="!users.length || reading || completed" :loading="pending">确认导入</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { useAppStore } from "@/stores/app";
import { ApiBatchCreateUser, ApiBatchLookupUsers } from "@/api/user";
import { useConfirm } from "@/utils/confirm";
import { getGeneralErrorMsg } from "@/utils/error";
import { parseRosterFile, type RosterUser } from "@/utils/roster-import";

const model = defineModel<boolean>();
const emit = defineEmits<{ (e: "created"): void }>();
const store = useAppStore();
const { sendSnack } = store;
const createConfirm = useConfirm();
const file = ref<File | File[] | null>(null);
const pending = ref(false);
const reading = ref(false);
const completed = ref(false);
const existingUserOption = ref<"ignore" | "overwrite" | "error">("ignore");
const users = ref<RosterUser[]>([]);
const sheetName = ref("");
const skippedDuplicates = ref(0);
const message = ref("");
const messageType = ref<"error" | "success" | "info">("info");
let readVersion = 0;
const roleName = (role: number) => role === 1 ? "教师" : "学生";

watch(file, async (value) => {
  const version = ++readVersion;
  users.value = [];
  message.value = "";
  completed.value = false;
  const selected = Array.isArray(value) ? value[0] : value;
  if (!selected) { reading.value = false; return; }
  reading.value = true;
  try {
    if (selected.size > 10 * 1024 * 1024) throw new Error("名单文件不能超过 10 MB。");
    const result = parseRosterFile(await selected.arrayBuffer(), selected.name);
    if (version !== readVersion) return;
    if (!store.isAdmin && result.users.some(user => user.role !== 0)) throw new Error("教师只能导入学生账号，请将角色设为学生。");
    users.value = result.users;
    sheetName.value = result.sheetName;
    skippedDuplicates.value = result.skippedDuplicates;
  } catch (error: any) {
    if (version !== readVersion) return;
    messageType.value = "error";
    message.value = error.message || "文件无法读取，请检查表格格式。";
  } finally {
    if (version === readVersion) reading.value = false;
  }
});
watch(existingUserOption, () => { completed.value = false; if (users.value.length) message.value = ""; });

async function batchCreateUsers() {
  if (pending.value || reading.value || !users.value.length || completed.value) return;
  pending.value = true;
  message.value = "";
  try {
    if (users.value.length > 6000 && !await createConfirm({ content: "名单超过 6000 位用户，处理可能需要较长时间，继续导入吗？" })) return;
    const existing = (await ApiBatchLookupUsers(users.value.map((u) => u.username))).data.success.map((u) => u.user);
    const existingNames = new Set(existing.map((u) => u.username));
    if (existing.length && existingUserOption.value === "error") throw new Error(`以下账号已存在，操作未执行：${existing.slice(0, 20).map((u) => u.username).join("、")}${existing.length > 20 ? "……" : ""}`);
    if (existingUserOption.value === "overwrite" && !store.isAdmin) throw new Error("教师不能覆盖已有账号，请选择忽略已有用户。");
    if (existing.length && existingUserOption.value === "overwrite" && !await createConfirm({ title: "覆盖已有账号", content: `将覆盖 ${existing.length} 位已有用户的姓名与角色，并将其管理中心密码重置为用户名。关联 HOJ 账号的原有登录密码不变。`, confirmationText: "确认覆盖" })) return;
    const rows = existingUserOption.value === "overwrite" ? users.value : users.value.filter((u) => !existingNames.has(u.username));
    if (rows.length) await ApiBatchCreateUser(rows);
    const ignored = users.value.length - rows.length;
    messageType.value = "success";
    message.value = `导入完成：处理 ${rows.length} 位用户${ignored ? `，忽略 ${ignored} 位已有用户` : ""}。${rows.length ? "新建账号的初始密码为学号 / 用户名。" : "所有账号均已存在，原信息和密码保留。"}\n请进入对应课程，通过“名单与课程设置”将学生加入课程。`;
    completed.value = true;
    sendSnack(message.value, "success");
    emit("created");
  } catch (error: any) {
    messageType.value = "error";
    message.value = error.response || error.request ? getGeneralErrorMsg(error) : error.message || "导入失败，请检查文件后重试。";
  } finally { pending.value = false; }
}
</script>
