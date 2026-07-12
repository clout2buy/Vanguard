export function planTasks(tasks) {
  return [...tasks]
    .sort((left, right) => (left.dependsOn?.length ?? 0) - (right.dependsOn?.length ?? 0))
    .map((task) => task.id);
}
