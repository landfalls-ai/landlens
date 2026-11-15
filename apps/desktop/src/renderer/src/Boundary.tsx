// What a view shows when drawing it threw: a notice in its place, the rest of the window still working. Data from the
// cluster has whatever shape anyone who can create the object chose (security review, wave 4 part 4, finding 7).
import { CircleX } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Ic } from "./icons";

export class Boundary extends Component<{ what: string; resetKey?: string; children: ReactNode }, { error?: Error; key?: string }> {
  state: { error?: Error; key?: string } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { error?: Error; key?: string }) {
    // A new list or object tries again.
    return props.resetKey !== state.key ? { error: undefined, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error) {
    console.error(`[landlens] ${this.props.what} failed to draw:`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="notice" role="alert">
        <Ic icon={CircleX} size={15} className="tone-bad" />
        <div className="notice-body">
          <strong>Couldn't show {this.props.what}.</strong>
          <p>Something in it has a shape Landlens didn't expect: {this.state.error.message.slice(0, 200)}</p>
        </div>
      </div>
    );
  }
}
