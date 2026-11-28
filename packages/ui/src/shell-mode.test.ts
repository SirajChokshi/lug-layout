import { TRAIN_PLAY, mainThreadModules, type PlaySnapshot } from "@brr/client";
import { cleanup, render, screen } from "@testing-library/react";
import { Container } from "inversify";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { ShellModeSwitch } from "./shell-mode.tsx";

afterEach(cleanup);

const MODES = ["Build", "Plan", "Play"];

function idlePlay(): PlaySnapshot {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  return container.get(TRAIN_PLAY).snapshot();
}

it("keeps Build and Plan out of reach while the trains start, so choosing them can't leave a train starting behind the switch", () => {
  const idle = idlePlay();
  const offered = (status: PlaySnapshot["status"]) => {
    cleanup();
    render(
      createElement(ShellModeSwitch, {
        mode: "play",
        play: { ...idle, status },
        onChoose: () => {},
      }),
    );
    return MODES.map((name) => !screen.getByRole("button", { name }).hasAttribute("disabled"));
  };

  expect({
    idle: offered("idle"),
    loading: offered("loading"),
    running: offered("running"),
  }).toEqual({
    idle: [true, true, true],
    loading: [false, false, true],
    running: [true, true, true],
  });
});
