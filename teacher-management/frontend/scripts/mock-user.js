/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node 脚本 */
const Mock = require("mockjs");
const fs = require("fs");

// 创建写入流
const ws = fs.createWriteStream("tmp/mock-batch-users.csv", { encoding: "utf8" });
ws.write("用户名,姓名,角色\n");

const exists = new Set(); // 存储已生成的用户名

for (let i = 0; i < 100000; i++) {
  // 生成唯一用户名
  let username;
  do {
    username = Mock.Random.string("abcdefghijklmnopqrstuvwxyz0123456789", 8);
  } while (exists.has(username));
  exists.add(username);

  // 生成记录
  const data = Mock.mock({
    name: "@cname",
    role: Mock.Random.natural(1, 100) <= 1 ? "教师" : "学生",
  });

  // 写入CSV行
  ws.write(`${username},${data.name},${data.role}\n`);
}

ws.end();
