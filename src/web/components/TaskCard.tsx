import { useApp } from "../state";
import { formatDue, isOverdue } from "../time";
import { taskStatusLabel, type Task, type TaskStatus } from "../types";
import { Icon } from "./Icon";
import { PriorityBadge } from "./ui";

/** "2/5" da checklist e número de comentários, quando houver. */
function Counts({ task }: { task: Task }) {
  return (
    <>
      {!!task.checklistTotal && (
        <span className={`meta-item${task.checklistDone === task.checklistTotal ? " all-done" : ""}`} title="Checklist">
          <Icon name="checklist" size={13} /> {task.checklistDone}/{task.checklistTotal}
        </span>
      )}
      {!!task.commentCount && (
        <span className="meta-item" title="Comentários">
          <Icon name="comment" size={13} /> {task.commentCount}
        </span>
      )}
    </>
  );
}

export function TaskRow({ task, onOpen, onStatus }: { task: Task; onOpen: () => void; onStatus: (s: TaskStatus) => void }) {
  const { projectName, memberName } = useApp();
  const done = task.status === "done";
  const overdue = isOverdue(task.dueAt, done);
  return (
    <li className={`task-row${done ? " is-done" : ""}`}>
      <input
        type="checkbox"
        className="check"
        checked={done}
        onChange={() => onStatus(done ? "todo" : "done")}
        aria-label={done ? `Reabrir ${task.title}` : `Concluir ${task.title}`}
      />
      <button type="button" className="task-main" onClick={onOpen}>
        <span className="task-title">{task.title}</span>
        <span className="task-meta">
          {task.dueAt && (
            <span className={overdue ? "due overdue" : "due"}>
              <Icon name="clock" size={13} /> {formatDue(task.dueAt)}
            </span>
          )}
          {task.projectId && <span className="chip">{projectName(task.projectId)}</span>}
          {task.assigneeId && (
            <span className="meta-item">
              <Icon name="user" size={13} /> {memberName(task.assigneeId)}
            </span>
          )}
          <Counts task={task} />
          {task.status !== "todo" && !done && <span className={`status-dot st-${task.status}`}>{taskStatusLabel[task.status]}</span>}
        </span>
      </button>
      <PriorityBadge priority={task.priority} />
    </li>
  );
}

export function KanbanCard({ task, onOpen, onStatus }: { task: Task; onOpen: () => void; onStatus: (s: TaskStatus) => void }) {
  const { projectName } = useApp();
  const overdue = isOverdue(task.dueAt, task.status === "done");
  return (
    <article
      className="kanban-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/task-id", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <button type="button" className="kanban-open" onClick={onOpen}>
        <span className="task-title">{task.title}</span>
      </button>
      <div className="kanban-meta">
        <PriorityBadge priority={task.priority} />
        {task.dueAt && <span className={overdue ? "due overdue" : "due"}>{formatDue(task.dueAt)}</span>}
        {task.projectId && <span className="chip">{projectName(task.projectId)}</span>}
        <Counts task={task} />
      </div>
      {/* No celular não há arrastar: o seletor move o cartão. */}
      <select className="kanban-move" value={task.status} onChange={(e) => onStatus(e.target.value as TaskStatus)} aria-label={`Mover ${task.title}`}>
        {Object.entries(taskStatusLabel).map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </article>
  );
}
