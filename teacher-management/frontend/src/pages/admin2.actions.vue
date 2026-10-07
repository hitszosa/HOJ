<template>
  <v-container>
    <div class="d-flex align-center flex-wrap ga-4 mt-6 mb-3">
      <h2 class="text-headline-large ma-0">最近管理动作</h2>
      <PageFilter v-model="filter" label="筛选操作人、动作或 IP" />
    </div>
    <p>此处只展示以下类型的操作：</p>
    <p>创建、更新、删除用户，创建、更新、删除课程，给用户重置密码，删除作业。</p>
    <v-skeleton-loader :loading="loading" type="card@5">
      <v-empty-state v-if="actions.length === 0" title="暂无操作记录" width="100%" />
      <v-empty-state
        v-else-if="filteredActions.length === 0"
        title="没有匹配的操作记录"
        width="100%"
      />

      <v-card
        :elevation="1"
        class="my-2 w-100"
        v-for="action in filteredActions"
        :key="action.id"
      >
        <v-card-text>
          <v-row density="compact" class="align-center">
            <v-col cols="12" sm="auto">
              <v-avatar>
                <v-icon>{{ getActionIcon(action) }}</v-icon>
              </v-avatar>
            </v-col>

            <v-col>
              <div class="text-caption text-grey">
                <v-chip :color="getActionColor(action.action)" size="small">
                  {{ formatActionType(action) }}
                </v-chip>
                {{ FormatDate(action.created_at) }}
              </div>
              <div class="text-body-2">
                操作人：{{ action.username }}
                <span class="text-grey">（IP: {{ action.ip_address }}）</span>
              </div>
            </v-col>

            <v-col cols="auto">
              <v-btn
                icon="mdi-chevron-down"
                variant="text"
                size="small"
                @click="toggleExpand(action.id)"
              />
            </v-col>
          </v-row>

          <v-expand-transition>
            <div v-show="expanded.has(action.id)">
              <v-divider class="my-2" />

              <div class="text-caption">
                <div v-if="action.affected_user_id">
                  影响用户ID：{{ action.affected_user_id }}
                </div>
                <div v-if="action.course_id">关联课程ID：{{ action.course_id }}</div>
                <div v-if="action.assignment_id">
                  关联作业ID：{{ action.assignment_id }}
                </div>
                <div class="text-grey mt-2">用户代理：{{ action.user_agent }}</div>
              </div>
            </div>
          </v-expand-transition>
        </v-card-text>
      </v-card>
      <p class="text-body-small text-grey">
        仅筛选当前已加载的最近记录。如需更多信息请查看运维日志。
      </p>
    </v-skeleton-loader>
  </v-container>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { ApiGetRecentActions, AuditAction } from "@/api/manage";
import { FormatDate } from "@/api/course";
import PageFilter from "@/components/PageFilter.vue";

const loading = ref(true);
const actions = ref<AuditAction[]>([]);
const filter = ref("");
const expanded = ref(new Set<number>());

// 动作类型映射
const ACTION_MAP: Record<string, string> = {
  BATCH_CREATE: "批量创建",
  CREATE: "创建",
  UPDATE: "更新",
  DELETE: "删除",
  DEACTIVATE: "删除",
  PASSWORD_CHANGE: "重置密码",
};

// 资源类型映射
const RESOURCE_MAP: Record<string, string> = {
  users: "用户",
  courses: "课程",
  assignments: "作业",
  files: "文件",
};

const ICON_MAP: Record<string, Record<string, string>> = {
  BATCH_CREATE: {
    users: "mdi-account-multiple-plus",
    courses: "mdi-book-plus-multiple",
    assignments: "mdi-file-document-plus-outline",
  },
  CREATE: {
    users: "mdi-account-plus",
    courses: "mdi-book-plus",
    assignments: "mdi-file-document-plus-outline",
  },
  UPDATE: {
    users: "mdi-account-edit",
    courses: "mdi-book-edit",
    assignments: "mdi-file-document-edit-outline",
  },
  DELETE: {
    users: "mdi-account-remove",
    courses: "mdi-book-remove",
    assignments: "mdi-file-document-remove-outline",
    files: "mdi-broom",
  },
  DEACTIVATE: {
    users: "mdi-account-remove",
    courses: "mdi-book-remove",
    assignments: "mdi-file-document-remove-outline",
  },
  PASSWORD_CHANGE: {
    users: "mdi-lock-reset",
  },
};

function toggleExpand(id: number) {
  const newSet = new Set(expanded.value);
  newSet.has(id) ? newSet.delete(id) : newSet.add(id);
  expanded.value = newSet;
}

function getActionColor(action: string) {
  return (
    {
      BATCH_CREATE: "success",
      CREATE: "success",
      UPDATE: "warning",
      DELETE: "error",
      DEACTIVATE: "error",
      PASSWORD_CHANGE: "info",
    }[action] || "grey"
  );
}

function formatActionType(action: AuditAction) {
  const type = ACTION_MAP[action.action] || action.action;
  if (action.action === "PASSWORD_CHANGE") return type;
  if (action.action === "DELETE" && action.resource_type === "files")
    return `清理文件存储`;
  return `${type}${RESOURCE_MAP[action.resource_type] || action.resource_type}`;
}

const filteredActions = computed(() => {
  const query = filter.value.trim().toLocaleLowerCase();
  if (!query) return actions.value;
  return actions.value.filter(
    (action) =>
      action.username.toLocaleLowerCase().includes(query) ||
      formatActionType(action).toLocaleLowerCase().includes(query) ||
      action.ip_address.toLocaleLowerCase().includes(query),
  );
});

function getActionIcon(auditAction: AuditAction) {
  const { action, resource_type: resource } = auditAction;
  return (ICON_MAP[action] || {})[resource] || "";
}

onActivated(async () => {
  try {
    const res = await ApiGetRecentActions();
    actions.value = res.data;
  } finally {
    loading.value = false;
  }
});
</script>

<route lang="yaml">
name: admin-actions
meta:
  layout: admin
  title: "最近动作"
</route>
