import { describe, expect, it } from "vitest";

import { CELL_FORGUNCY_PROP_KEYS, CELL_PROPS_BASE_KEYS } from "@forguncy-react-workspace/core";

import { RuntimeFacadeContractError } from "./capabilities";
import type { RuntimeFacadeCellProps, RuntimeFacadeHostBindings } from "./contract";
import {
  createMockDataSource,
  createMockRuntimeFacadeProvider,
  mockUndeclaredDataSourceMessage,
} from "./mock-provider";

function cellPropsOf(provider: { readonly bindings: RuntimeFacadeHostBindings }): Record<string, unknown> {
  return provider.bindings.cellProps as unknown as Record<string, unknown>;
}

// The mock is a stand-in, so its *shape* has to match the host's. Both halves of
// that are checked here: the addresses it fills, and the addresses it refuses to
// fill.
describe("mock provider shape", () => {
  it("fills every base prop key and handle member `core` verified", () => {
    const props = cellPropsOf(createMockRuntimeFacadeProvider());
    expect(Object.keys(props).sort()).toEqual([...CELL_PROPS_BASE_KEYS].sort());
    expect(Object.keys(props.Forguncy as object).sort()).toEqual([...CELL_FORGUNCY_PROP_KEYS].sort());
  });

  /**
   * The parity rule, and the reason it is a construction-time refusal rather than
   * a note: a mock that could supply `navigate` would let a Cell pass every local
   * check and fail on the first real page, which is the one failure mode a local
   * harness exists to prevent.
   */
  it("refuses to impersonate an address the host does not have", () => {
    expect(() =>
      createMockRuntimeFacadeProvider({ forguncyMembers: { navigate: () => undefined } as never }),
    ).toThrow(/not a member #5 verified/);

    expect(() => createMockRuntimeFacadeProvider({ cellProps: { theme: "dark" } as never })).toThrow(
      /not one #5 verified/,
    );

    let caught: unknown;
    try {
      createMockRuntimeFacadeProvider({ forguncyMembers: { navigate: () => undefined } as never });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeFacadeContractError);
    expect((caught as RuntimeFacadeContractError).code).toBe("unknown-host-binding");
  });

  // A value prop the mock was not given stays `undefined` rather than being
  // defaulted: #5 pinned the key and left what an empty snapshot means open, so a
  // default here would assert a shape on the host's behalf.
  it("leaves an unsupplied value prop undefined instead of plausible", () => {
    const props = cellPropsOf(createMockRuntimeFacadeProvider());
    expect(props.Permissions).toBeUndefined();
    expect(props.ImageContext).toBeUndefined();
    expect(props.ServerCommands).toEqual({});
  });

  it("carries the kind a harness reports, and the same port as the host", () => {
    const mock = createMockRuntimeFacadeProvider();
    expect(mock.kind).toBe("mock");
    expect(Object.keys(mock.bindings).sort()).toEqual(["cellProps", "useDataSource"]);
  });
});

describe("mock data sources", () => {
  it("answers a declared source and leaves the count server-side", () => {
    const sales = createMockDataSource([{ id: 1 }, { id: 2 }, { id: 3 }], { totalCount: 240 });
    const result = sales({ top: 2 });

    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    // #5: `top: 3` returned three rows while `totalCount` stayed 72, so the count
    // is the declared one rather than the number of rows on hand.
    expect(result.totalCount).toBe(240);
    expect(result.loading).toBe(false);
    expect(result.error).toBeNull();
  });

  it("applies offset the way the server does, and defaults the count to the rows it has", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(createMockDataSource(rows)({ offset: 1 })).toMatchObject({
      data: [{ id: 2 }, { id: 3 }],
      totalCount: 3,
    });
    expect(createMockDataSource(rows)({ top: 2, offset: 1 }).data).toEqual([{ id: 2 }, { id: 3 }]);
    expect(createMockDataSource(rows)().data).toHaveLength(3);
  });

  /**
   * A stated non-claim rather than a silent one.
   *
   * Ordering on the target is the server's — it depends on the database collation
   * rather than on the rows the client holds — so a local sort would encode a guess
   * as a simulation. The helper therefore ignores `orderBySqlParams`, and this test
   * exists so that the limitation is a named behaviour instead of an accident a
   * project discovers when local results stop predicting production ones.
   */
  it("does not pretend to apply server-side ordering", () => {
    const rows = [{ id: 3 }, { id: 1 }, { id: 2 }];
    const ordered = createMockDataSource(rows)({
      orderBySqlParams: [{ ColumnName: "id", Order: "DESC" }],
    });
    expect(ordered.data).toEqual(rows);
  });

  // #5 records the undeclared case as an error *state* whose message contains the
  // name, so the mock reproduces that rather than throwing — the alternative would
  // make local development stricter than the target.
  it("answers an undeclared source with the host's error state", () => {
    const bindings = createMockRuntimeFacadeProvider({ dataSources: {} }).bindings;
    expect(() => bindings.useDataSource("NoSuchSource")).not.toThrow();

    const result = bindings.useDataSource("NoSuchSource");
    expect(result).toEqual({
      data: [],
      totalCount: 0,
      loading: false,
      error: mockUndeclaredDataSourceMessage("NoSuchSource"),
    });
    // The property #5 pinned is that the message *contains* the name; the exact
    // product wording is not evidence this repository has.
    expect(String(result.error)).toContain("NoSuchSource");
  });
});

describe("mock server commands", () => {
  // The host's own shape, kept: a name the designer did not list is `undefined` on
  // the record. The façade is where that becomes a named failure, not here.
  it("leaves an unconfigured name undefined rather than substituting behaviour", () => {
    const serverCommands = cellPropsOf(createMockRuntimeFacadeProvider()).ServerCommands as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(serverCommands, "GetSalesData")).toBe(false);
    expect(serverCommands.GetSalesData).toBeUndefined();
  });

  it("carries the commands the project supplied with the declared parameter tuple", async () => {
    const provider = createMockRuntimeFacadeProvider<{ GetSalesData: [payload: { top: number }] }>({
      serverCommands: {
        GetSalesData: async payload => ({ errorCode: 0, errorMessage: "OK", echo: payload.top }),
      },
    });

    // `payload` is the declared tuple's parameter, which is what makes the mock as
    // typed as the real binding rather than looser than it: the option is typed
    // `ServerCommandBindings<Commands>`, so the line above only compiles while
    // `payload` is `{ top: number }`.
    //
    // Reading the value back needs one cast, and for the same reason the port has
    // one: `RuntimeFacadeCellProps.ServerCommands` deliberately declares no command
    // (`contract.ts`), so the record is addressed the way a generated binding
    // addresses it — by name, at the boundary.
    const commands = provider.bindings.cellProps.ServerCommands as unknown as {
      GetSalesData?: (payload: { top: number }) => Promise<{ echo?: unknown }>;
    };
    const result = await commands.GetSalesData?.({ top: 3 });
    expect(result?.echo).toBe(3);
  });
});

describe("mock cell props typing", () => {
  // The mock's `cellProps` has to be assignable where a host's `props` is, or the
  // two providers would not be interchangeable.
  it("is assignable to the port's cell props", () => {
    const props: RuntimeFacadeCellProps = createMockRuntimeFacadeProvider().bindings.cellProps;
    expect(Object.keys(props).length).toBe(CELL_PROPS_BASE_KEYS.length);
  });
});
