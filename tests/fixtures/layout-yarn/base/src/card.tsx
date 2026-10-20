import { Panel } from "tiny-ui";

export function Card(props: { title: string }) {
  return <Panel label={props.title} />;
}
