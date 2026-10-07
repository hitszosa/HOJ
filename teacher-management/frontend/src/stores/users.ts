import { ref } from "vue";
import { defineStore } from "pinia";
import { ApiBatchLookupUsers, ApiGetUsersList, UserInfo } from "@/api/user";

export const useUsersStore = defineStore("users", () => {
  const userByIdMap = ref(new Map<number, UserInfo>());

  async function fetchAllUsers() {
    const { data } = await ApiGetUsersList();
    updateMap(data);
  }

  async function fetchUsersById(ids: number[]) {
    if (!ids.length) return;
    const { data } = await ApiBatchLookupUsers([], ids);
    updateMap(data.success.map(({ user }) => user));
  }

  function updateMap(users: UserInfo[]) {
    // console.log("# update Map starts: ", performance.now(), 'users.length: ', users.length);
    if (users.length > userByIdMap.value.size) {
      const newMap = new Map(users.map((u) => [u.id, u]));
      for (const u of userByIdMap.value.values()) {
        if (!newMap.has(u.id)) {
          newMap.set(u.id, u);
        }
      }
      userByIdMap.value = newMap;
    } else {
      const newMap = new Map(userByIdMap.value);
      for (const u of users) {
        newMap.set(u.id, u);
      }
      userByIdMap.value = newMap;
    }
    // console.log("# update Map ends: ", performance.now());
  }

  function getUsersById(ids: number[]): UserInfo[] {
    return ids.map((id) => userByIdMap.value.get(id)).filter(Boolean) as UserInfo[];
  }

  return {
    updateMap,
    fetchUsersById,
    userByIdMap,
    fetchAllUsers,
    getUsersById,
  };
});
