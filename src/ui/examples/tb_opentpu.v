`timescale 1ns/1ps
// Testbench for OpenTPU (UCSB ArchLab), 8x8 matrix unit; opentpu.v is OpenTPU's PyRTL design exported to Verilog.
// Like OpenTPU's runtpu.py it plays host memory and weight DRAM, loads the "simplemult" program
// (read 8 vectors, load one weight tile, multiply, ReLU, write the results back) and checks the results.
module tb_opentpu;
  reg          clk = 1'b0;
  reg          rst = 1'b1;
  reg  [63:0]  hostmem_rdata = 64'd0;
  reg  [511:0] weights_dram_in = 512'd0;
  reg          weights_dram_valid = 1'b0;
  wire         halt, hostmem_re, hostmem_we, weights_dram_read, assertion0, assertion1;
  wire [63:0]  hostmem_raddr, hostmem_waddr, hostmem_wdata;
  wire [39:0]  weights_dram_raddr;

  opentpu dut (
    .clk(clk), .rst(rst),
    .hostmem_rdata(hostmem_rdata), .weights_dram_in(weights_dram_in), .weights_dram_valid(weights_dram_valid),
    .assertion0(assertion0), .assertion1(assertion1), .halt(halt),
    .hostmem_raddr(hostmem_raddr), .hostmem_re(hostmem_re), .hostmem_waddr(hostmem_waddr),
    .hostmem_wdata(hostmem_wdata), .hostmem_we(hostmem_we),
    .weights_dram_raddr(weights_dram_raddr), .weights_dram_read(weights_dram_read)
  );

  always #5 clk = ~clk;

  // host memory: one 8-element vector of int8 per address, element 0 in the low byte
  reg [63:0]  hostmem [0:15];
  // weight DRAM: one 8x8 tile of int8 per address (one 512-bit transfer)
  reg [511:0] weightmem [0:0];

  // instruction = {opcode, flags, length, address (8 bytes), unified buffer address (3 bytes)}
  function [111:0] instr(input [7:0] op, input [7:0] flags, input [7:0] len, input [63:0] addr, input [23:0] ub);
    instr = {op, flags, len, addr, ub};
  endfunction

  integer i;
  initial begin
    // PyRTL simulation starts with every memory at 0; Verilog memories start unknown, so clear them:
    // mem_0 instruction memory, mem_1 unified buffer, mem_2..mem_9 accumulators (one per column).
    // (mem_10..mem_17 are the sigmoid lookup ROMs, initialized by the design itself.)
    for (i = 0; i < 512; i = i + 1) dut.mem_0[i] = 112'd0;
    for (i = 0; i < 256; i = i + 1) begin
      dut.mem_1[i] = 64'd0;
      dut.mem_2[i] = 32'd0; dut.mem_3[i] = 32'd0; dut.mem_4[i] = 32'd0; dut.mem_5[i] = 32'd0;
      dut.mem_6[i] = 32'd0; dut.mem_7[i] = 32'd0; dut.mem_8[i] = 32'd0; dut.mem_9[i] = 32'd0;
    end
    // the program in the instruction memory; empty slots are NOPs
    dut.mem_0[0]   = instr(8'h06, 8'h00, 8'd8, 64'd0, 24'd0);  // RHM 0, 0, 8   host[0..7] -> UB[0..7]
    dut.mem_0[1]   = instr(8'h02, 8'h00, 8'd0, 64'd0, 24'd0);  // RW 0          weight tile 0 -> weight FIFO
    dut.mem_0[102] = instr(8'h03, 8'h01, 8'd8, 64'd0, 24'd0);  // MMC.S 0, 0, 8 UB[0..7] x W -> ACC[0..7], switch weights
    dut.mem_0[303] = instr(8'h04, 8'h08, 8'd8, 64'd0, 24'd0);  // ACT.R 0, 0, 8 ReLU(ACC[0..7]) -> UB[0..7]
    dut.mem_0[404] = instr(8'h01, 8'h00, 8'd8, 64'd0, 24'd0);  // WHM 0, 0, 8   UB[0..7] -> host[0..7]
    dut.mem_0[429] = instr(8'h07, 8'h00, 8'd0, 64'd0, 24'd0);  // HLT
    // input vectors and weights (OpenTPU's simplemult_hostmem.npy and simplemult_weights.npy)
    hostmem[0] = 64'h030400fdfefdfd40;
    hostmem[1] = 64'hfffd01020301fd40;
    hostmem[2] = 64'hfc0101fffbfdff40;
    hostmem[3] = 64'hfcfffdfd00ff0240;
    hostmem[4] = 64'hff0400fe02040340;
    hostmem[5] = 64'h02010204feff0440;
    hostmem[6] = 64'h0100fd0400fbfb40;
    hostmem[7] = 64'h00fc0303fd000440;
    for (i = 8; i < 16; i = i + 1) hostmem[i] = 64'd0;
    // 126 on the diagonal, -121 elsewhere
    weightmem[0] = 512'h7e87878787878787877e87878787878787877e87878787878787877e87878787878787877e87878787878787877e87878787878787877e87878787878787877e;
  end

  // the memory side, one transfer per clock: answers what the TPU asked for in the cycle that just ended
  reg     sending = 1'b0;
  integer cycles = 0;
  always @(posedge clk) if (!rst) begin
    cycles <= cycles + 1;
    weights_dram_valid <= sending;
    weights_dram_in    <= sending ? weightmem[0] : 512'd0;
    sending            <= weights_dram_read;
    hostmem_rdata      <= hostmem_re ? hostmem[hostmem_raddr[3:0]] : 64'd0;
    if (hostmem_we) hostmem[hostmem_waddr[3:0]] <= hostmem_wdata;
    if (weights_dram_read && weights_dram_raddr != 0) $display("** unexpected weight address %0d", weights_dram_raddr);
  end

  // expected results: ReLU(X * W), quantized to 8 bits, from OpenTPU's hardware and functional simulators
  reg [63:0] expected [0:7];
  initial begin
    expected[0] = 64'd100; expected[1] = 64'd128; expected[2] = 64'd44;  expected[3] = 64'd58;
    expected[4] = 64'd198; expected[5] = 64'd198; expected[6] = 64'd72;  expected[7] = 64'd21;
  end

  integer errors = 0, k;

  // OpenTPU's rtl_assert checks are outputs that stay 1 while they hold:
  // assertion0 - no MMC while the matrix unit is still busy, assertion1 - no ACT while the activation unit is busy
  always @(posedge clk) if (!rst && (assertion0 !== 1'b1 || assertion1 !== 1'b1)) begin
    $display("** assertion failed at cycle %0d: assertion0=%b assertion1=%b", cycles, assertion0, assertion1);
    errors = errors + 1;
  end
  initial begin
    $display("OpenTPU 8x8: simplemult (RHM, RW, MMC, ACT ReLU, WHM)");
    #12 rst = 1'b0;
    wait (halt);
    @(posedge clk);
    $display("HLT after %0d cycles; host memory:", cycles);
    for (i = 0; i < 8; i = i + 1) begin
      $write("  host[%0d] =", i);
      for (k = 0; k < 8; k = k + 1) $write(" %4d", hostmem[i][k*8 +: 8]);
      $display("");
      if (hostmem[i] !== expected[i]) errors = errors + 1;
    end
    if (errors == 0) $display("PASS"); else $display("FAIL: %0d errors", errors);
    $finish;
  end
endmodule
