import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfigErrorScreen } from "./ConfigErrorScreen";

describe("ConfigErrorScreen", () => {
  it("names every variable that is wrong and what is wrong with it", () => {
    render(
      <ConfigErrorScreen
        problems={[
          { name: "VITE_API_URL", message: "is missing" },
          { name: "VITE_COGNITO_CLIENT_ID", message: "is empty" },
        ]}
      />,
    );

    expect(screen.getByRole("heading", { name: "The app is not configured" })).toBeInTheDocument();
    const items = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual(["VITE_API_URL is missing", "VITE_COGNITO_CLIENT_ID is empty"]);
  });
});
