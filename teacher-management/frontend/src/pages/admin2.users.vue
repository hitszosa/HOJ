<template>
  <v-container>
    <v-alert v-if="!isAdmin" type="info" variant="tonal" class="my-4">教师可添加学生账号并管理本班名单；教师账号、角色调整、密码重置和停用由超级管理员维护。</v-alert>
    <div class="d-flex align-center flex-wrap ga-4 mt-6 mb-3">
      <h2 class="text-headline-large ma-0">用户</h2>
      <PageFilter v-model="search" label="搜索用户名、学号或姓名" />
      <div v-if="isTeacher" class="d-flex align-center flex-wrap ga-2">
        <v-btn variant="outlined" prepend-icon="mdi-account-plus" @click="beginCreateUser">{{ isAdmin ? '添加用户' : '添加学生' }}</v-btn>
        <v-btn color="primary" prepend-icon="mdi-file-excel" @click="batchCreateUsersDialog = true">Excel 导入名单</v-btn>
        <v-btn href="/management/student-roster-template.xlsx" download prepend-icon="mdi-download" variant="outlined">下载 Excel 模板</v-btn>
      </div>
    </div>
    <v-data-table-server
      :loading
      :headers="[
        { title: '用户名/学号', value: 'username' },
        { title: '姓名', value: 'real_name' },
        { title: '角色', value: 'role' },
        { title: '密码修改提醒', value: 'password_expired' },
        {
          title: '操作',
          value: 'action',
          sortable: false,
          align: 'center',
        },
      ]"
      :items-length="totalItems"
      :items-per-page="pageSize"
      :items-per-page-options="[10, 25, 50, 100, ...(totalItems <= 1000 ? [-1] : [])]"
      :page="currentPage"
      :items="users"
      @update:options="
        ({ page, itemsPerPage }) => {
          currentPage = page;
          pageSize = itemsPerPage;
          loadUsers();
        }
      "
      density="compact"
    >
      <!-- eslint-disable-next-line vue/valid-v-slot -- vue-eslint-parser 将点号 slot 名误解析为修饰符；编译器按 "body.prepend" 处理，属合法用法 -->
      <template #body.prepend v-if="pendingNewUser">
        <tr>
          <td>
            <v-text-field
              label="学号 / 用户名"
              v-model="pendingNewUser.username"
              autofocus
              density="compact"
              variant="underlined"
              hide-details
            />
          </td>
          <td>
            <v-text-field
              label="姓名"
              v-model="pendingNewUser.real_name"
              density="compact"
              variant="underlined"
              hide-details
            />
          </td>
          <td>
            <v-select
              label="角色"
              v-model="pendingNewUser.role"
              :items="isAdmin ? roleItems : roleItems.slice(0, 1)"
              :list-props="{ density: 'compact' }"
              density="compact"
              variant="underlined"
              hide-details
            />
          </td>
          <td>建议修改</td>
          <td class="text-center">
            <v-btn
              variant="text"
              icon="mdi-close"
              aria-label="取消添加用户"
              size="x-small"
              @click="cancelCreateUser"
            />
            <v-btn variant="text" icon="mdi-check" aria-label="保存新用户" size="x-small" @click="createUser" />
          </td>
        </tr>
      </template>
      <template #[`item.username`]="{ item }">
        <v-text-field
          v-if="newUserInfo[item.id]?._edit"
          v-model="newUserInfo[item.id].username"
          density="compact"
          variant="underlined"
          hide-details
        />
        <template v-else> {{ item.username }} </template>
      </template>
      <template #[`item.real_name`]="{ item }">
        <v-text-field
          v-if="newUserInfo[item.id]?._edit"
          v-model="newUserInfo[item.id].real_name"
          density="compact"
          variant="underlined"
          hide-details
        />
        <template v-else>{{ item.real_name }}</template>
      </template>
      <template #[`item.role`]="{ item }">
        <v-select
          v-if="newUserInfo[item.id]?._edit"
          v-model="newUserInfo[item.id].role"
          :items="roleItems"
          :list-props="{ density: 'compact' }"
          density="compact"
          variant="underlined"
          hide-details
        />
        <template v-else>{{ roleName(item.role) }}</template>
      </template>
      <template #[`item.password_expired`]="{ item }">
        <span title="此项只是修改密码的提醒，不表示账号停用或不能登录。">{{ item.password_expired ? "建议修改" : "无提醒" }}</span>
      </template>
      <template #[`item.action`]="{ item }">
        <template v-if="newUserInfo[item.id]?._edit">
          <v-menu>
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                variant="text"
                size="x-small"
                icon="mdi-dots-vertical"
              />
            </template>
            <v-list density="compact" slim>
              <v-list-item
                prepend-icon="mdi-close"
                title="放弃更改"
                @click="endEdit(item.id)"
              />
              <v-list-item
                prepend-icon="mdi-lock-reset"
                title="重置密码"
                @click="resetPasswordFor(item)"
              />
              <v-list-item
                prepend-icon="mdi-delete"
                title="删除此用户"
                class="text-error"
                @click="deleteUser(item)"
              />
            </v-list>
          </v-menu>
          <v-btn variant="text" icon="mdi-check" size="x-small" @click="saveEdit(item)" />
        </template>
        <v-btn
          v-else-if="isAdmin"
          variant="text"
          icon="mdi-pencil"
          size="x-small"
          @click="beginEdit(item.id)"
        />
      </template>
    </v-data-table-server>
    <!-- 留白避免浮动按钮挡住内容 -->
    <div style="height: 80px" />
    <v-fab v-if="isTeacher" size="x-large" icon app color="light-blue-darken-4">
      <v-icon>mdi-plus</v-icon>
      <v-speed-dial activator="parent" transition="fade-transition">
        <v-btn key="2" icon @click="beginCreateUser()">
          <v-icon>mdi-account-plus</v-icon>
          <v-tooltip activator="parent" text="添加单个用户" />
        </v-btn>
        <v-btn key="1" @click="batchCreateUsersDialog = true" icon>
          <v-icon>mdi-account-multiple-plus</v-icon>
          <v-tooltip activator="parent" text="批量添加用户" />
        </v-btn>
        <v-btn
          key="4"
          icon
          @click="
            createConfirm({
              title: '敬请期待',
              content: '此功能尚未实现。',
              confirmationText: '好',
              cancellationButtonProps: { style: { display: 'none' } },
            })
          "
        >
          <v-icon>mdi-checkbox-multiple-marked</v-icon>
          <v-tooltip activator="parent" text="多选" />
        </v-btn>
      </v-speed-dial>
    </v-fab>
    <RosterImportDialog
      v-model="batchCreateUsersDialog"
      @created="throttledLoadUsers"
    />
  </v-container>
</template>

<script setup lang="ts">
import {
  ApiChangePasswordFor,
  ApiDeleteUser,
  ApiFuzzyUserLookup,
  ApiSetUserInfo,
  type UserInfo,
  ApiCreateUser,
} from "@/api/user";
import { watch, onUnmounted } from "vue";
import { throttle } from "lodash-es";
import { ApiGetUserInfo } from "@/api/user";
import { useConfirm } from "@/utils/confirm";
import { useAppStore } from "@/stores/app";
import { useGoTo } from "vuetify";
import { getGeneralErrorMsg } from "@/utils/error";
import PageFilter from "@/components/PageFilter.vue";

const createConfirm = useConfirm();
const { sendSnack } = useAppStore();
const isAdmin = computed(() => useAppStore().isAdmin);
const isTeacher = computed(() => useAppStore().isTeacher);
const goTo = useGoTo();

const search = ref("");
const loading = ref(true);
const currentPage = ref(1);
const pageSize = ref(20);
const totalItems = ref(0);
const users = ref<UserInfo[]>([]);

const newUserInfo = ref({} as { [index: number]: UserInfo & { _edit?: boolean } });
const batchCreateUsersDialog = ref(false);
const route = useRoute();
watch(() => route.query.import, (value) => { if (value === '1' && isTeacher.value) batchCreateUsersDialog.value = true; }, { immediate: true });
const pendingNewUser = ref<(Omit<UserInfo, "id"> & { id?: number }) | null>(null);
const roleItems = [
  { title: "学生", value: 0 },
  { title: "教师", value: 1 },
  { title: "管理员", value: 2 },
];

function roleName(role: number) {
  return roleItems.find((item) => item.value === role)?.title ?? "未知";
}

async function beginCreateUser() {
  if (pendingNewUser.value === null) {
    pendingNewUser.value = {
      id: 0,
      username: "",
      real_name: "",
      role: 0,
      password_expired: true,
    };
  }
  await nextTick();
  goTo(0);
}

async function createUser() {
  if (!pendingNewUser.value) return;
  if (!pendingNewUser.value.username) {
    sendSnack(`用户名不得为空。`, "warning");
    return;
  }
  if (!pendingNewUser.value.real_name) {
    sendSnack(`姓名不得为空。`, "warning");
    return;
  }

  try {
    const { id: _unused, ...userData } = pendingNewUser.value;
    const { data } = await ApiCreateUser(userData);

    users.value.unshift(data);
    sendSnack("用户创建成功。初始密码是用户名。");
    pendingNewUser.value = null;
  } catch (error: any) {
    const msg = "创建用户失败。" + getGeneralErrorMsg(error);
    sendSnack(msg, "error");
  }
}

function cancelCreateUser() {
  pendingNewUser.value = null;
}

async function loadUsers() {
  try {
    loading.value = true;
    const response = await ApiFuzzyUserLookup(
      search.value,
      pageSize.value == -1 ? 0 : pageSize.value,
      currentPage.value,
      undefined,
      true,
    );
    users.value = response.data.result;
    totalItems.value = response.data.length ?? response.data.result.length;
  } catch (error: any) {
    sendSnack(`加载用户失败：${getGeneralErrorMsg(error)}`, "error");
  } finally {
    loading.value = false;
  }
}

const throttledLoadUsers = throttle(loadUsers, 400);

watch(search, () => {
  currentPage.value = 1;
  throttledLoadUsers();
});

onActivated(throttledLoadUsers);

onUnmounted(() => {
  throttledLoadUsers.cancel();
});

async function beginEdit(id: number) {
  try {
    newUserInfo.value[id] = {
      _edit: true,
      ...(await ApiGetUserInfo(id)).data,
    };
  } catch (error: any) {
    sendSnack(`出错了：${getGeneralErrorMsg(error)}\n请尝试刷新页面。`, "warning");
  }
}

async function saveEdit(oldUser: UserInfo) {
  const id = oldUser.id;
  const newUser = newUserInfo.value[id];
  try {
    const resp = await ApiSetUserInfo(id, newUser);
    sendSnack(`修改已生效。`);
    delete newUserInfo.value[id];
    Object.assign(oldUser, resp.data);
  } catch (error: any) {
    sendSnack(`出错了：${getGeneralErrorMsg(error)}`, "warning");
  }
}

function endEdit(id: number) {
  delete newUserInfo.value[id];
}

async function resetPasswordFor(user: UserInfo) {
  const confirmed = await createConfirm({
    content: `确定要为“${user.real_name}”重置密码吗？\n仅当用户忘记密码时才应当这么做。`,
  });
  if (!confirmed) {
    return;
  }
  try {
    const newpass =
      "GRA+" + window.crypto.getRandomValues(new BigUint64Array(1))[0].toString(36);
    console.log(newpass);
    const newUser = (await ApiChangePasswordFor(user.username, newpass)).data;
    Object.assign(user, newUser);
    await createConfirm({
      title: "重置密码成功",
      content: `已为“${user.real_name}”重置密码，新的密码是：\n${newpass}\n请复制此密码并及时告知用户。`,
      cancellationButtonProps: { style: { display: "none" } },
    });
  } catch (error: any) {
    sendSnack(`出错了：${getGeneralErrorMsg(error)}`, "warning");
  } finally {
    endEdit(user.id);
  }
}

async function deleteUser(u: UserInfo) {
  const confirmed1 = await createConfirm({
    content: `确定要删除用户“${u.real_name}”（${u.username}）吗？\n此操作是不可逆的，并有可能带来严重的后果！`,
    confirmationButtonProps: { color: "error" },
  });
  if (!confirmed1) return;
  const keyword = `delete user ${u.username}`;
  const confirmed2 = await createConfirm({
    titleComponent: () => "",
    cardProps: {
      title: `删除用户“${u.real_name}”（${u.username}）`,
      prependIcon: "mdi-account-remove",
    },
    content: `您正在执行危险操作。请将文字“${keyword}”输入到以下框中以确认执行。`,
    confirmationButtonProps: { color: "error" },
    confirmationKeyword: keyword,
  });
  if (!confirmed2) return;
  try {
    await ApiDeleteUser(u.id);
    users.value.splice(
      users.value.findIndex((v) => v.id == u.id),
      1,
    );
    sendSnack(`已删除用户。`);
  } catch (error: any) {
    sendSnack(`出错了：${getGeneralErrorMsg(error)}`, "warning");
  } finally {
    endEdit(u.id);
  }
}
</script>

<route lang="yaml">
name: admin-users
meta:
  layout: admin
  title: "用户管理"
</route>
