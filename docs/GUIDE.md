# WebSim 사용자 가이드

WebSim 은 브라우저에서 동작하는 Verilog / SystemVerilog / VHDL 이벤트 구동 시뮬레이터입니다.
라이브러리 → 컴파일(`vlog`/`vcom`) → 엘라보레이션(`vsim`) → 실행(`run`) → 파형 분석으로 이어지는
전통적인 데스크톱 HDL 시뮬레이터의 작업 흐름을 그대로 따르며, 모든 작업은 브라우저 안에서 실행되고
파일은 브라우저 저장소(localStorage)에 보관됩니다.

- 온라인: <https://infinity9753.github.io/websim/>
- 화면 언어: 보기 ▸ English / 한국어 (기본값은 브라우저 언어). 시뮬레이터 메시지는 도구 호환을 위해 영어로 유지됩니다.

목차

1. [화면 구성](#1-화면-구성)
2. [튜토리얼 1 — Verilog 카운터](#2-튜토리얼-1--verilog-카운터)
3. [튜토리얼 2 — VHDL](#3-튜토리얼-2--vhdl)
4. [파형 창](#4-파형-창)
5. [디버깅: 브레이크포인트, 스텝, force](#5-디버깅-브레이크포인트-스텝-force)
6. [분석 도구: 리스트, 데이터플로, 커버리지, VCD](#6-분석-도구-리스트-데이터플로-커버리지-vcd)
7. [프로젝트, 폴더, 검색](#7-프로젝트-폴더-검색)
8. [Transcript 명령 레퍼런스](#8-transcript-명령-레퍼런스)
9. [지원 언어 범위](#9-지원-언어-범위)
10. [단축키](#10-단축키)

---

## 1. 화면 구성

| 영역 | 내용 |
|---|---|
| 메뉴 / 툴바 | 파일, 보기, 컴파일, 시뮬레이션, 파형, 도움말. 툴바의 실행 시간 칸(예: `100 ns`)은 `run` 버튼이 진행할 시간입니다. |
| 왼쪽: 프로젝트 | 소스 파일 트리(폴더 지원)와 컴파일 상태(✓ 성공, ✗ 오류, ? 미컴파일), 컴파일 순서. 더블 클릭하면 편집기로 엽니다. |
| 왼쪽: 라이브러리 | 컴파일된 설계 단위(모듈, 엔티티, 아키텍처, 패키지, 구성, 인터페이스). 더블 클릭하면 시뮬레이션을 시작합니다. |
| 왼쪽: sim | 로드된 설계의 인스턴스 계층. 인스턴스를 고르면 오브젝트 창이 바뀝니다. |
| 왼쪽: 검색 | 프로젝트 전체 파일 검색(Ctrl+Shift+F). |
| 가운데: 오브젝트 | 현재 영역의 신호와 값. 끌어서 파형 창에 놓거나 더블 클릭하면 파형에 추가됩니다. 오른쪽 클릭: 파형/리스트에 추가, Force, 값 확인, 데이터플로. |
| 가운데: 프로세스 / 메모리 / 지역 변수 | 프로세스 상태, 메모리 내용(편집 가능), 일시 정지 중인 프로세스의 지역 변수와 호출 스택. |
| 오른쪽: 파형 / 리스트 / 데이터플로 / 편집기 | 파형 뷰어, 시간별 값 표, 신호의 구동원·부하 그래프, 소스 편집기 탭. |
| 아래: 트랜스크립트 | 명령 입력 창과 시뮬레이터 출력. `file(line)` 형태의 위치는 클릭하면 해당 줄로 이동합니다. ↑/↓ 명령 기록, Tab 자동 완성. |
| 상태 표시줄 | 실행 상태, 현재 시간, 델타, 현재 영역, 파형 히스토리 크기, 프로젝트와 라이브러리. |

처음 방문하면 카운터 예제가 로드되고 `run_counter.do` 가 실행됩니다. 다른 예제는 **파일 ▸ 예제 불러오기** 에서 고를 수 있습니다.

## 2. 튜토리얼 1 — Verilog 카운터

1. **파일 ▸ 새 파일…** 에서 `up_counter.v` 를 만듭니다(확장자로 언어가 정해집니다).

   ```verilog
   `timescale 1ns/1ps
   module up_counter (input clk, input rst, output reg [3:0] q);
     always @(posedge clk)
       if (rst) q <= 0;
       else     q <= q + 1;
   endmodule
   ```

2. 테스트벤치 `tb_up.v` 를 만듭니다.

   ```verilog
   `timescale 1ns/1ps
   module tb_up;
     reg clk = 0, rst = 1;
     wire [3:0] q;
     up_counter dut (.clk(clk), .rst(rst), .q(q));
     always #5 clk = ~clk;
     initial begin
       #20 rst = 0;
       #200 $display("q = %0d", q);
       $finish;
     end
   endmodule
   ```

3. 컴파일: 툴바의 **모두 컴파일**(Shift+F7) 또는 트랜스크립트에서

   ```tcl
   vlib work
   vlog up_counter.v tb_up.v
   ```

   오류가 나면 `** Error: tb_up.v(7): ...` 줄을 클릭해 해당 위치로 이동합니다.

4. 시뮬레이션 시작: 라이브러리 창에서 `tb_up` 을 더블 클릭하거나 **시뮬레이션 ▸ 시뮬레이션 시작…** (분해능, 제네릭, 커버리지 선택 가능) 또는

   ```tcl
   vsim work.tb_up
   add wave -r /*
   run -all
   ```

5. 결과 확인: 트랜스크립트에 `q = ...` 가 출력되고 파형 창에 신호가 보입니다. 파형을 클릭하면 커서가 놓이고 값 열이 커서 시각의 값을 보여 줍니다.

6. 반복 작업은 do 파일로 만듭니다. 예: `run.do`

   ```tcl
   vlib work
   vlog up_counter.v tb_up.v
   vsim work.tb_up
   add wave -radix unsigned /tb_up/q
   run 300 ns
   ```

   트랜스크립트에서 `do run.do`, 또는 프로젝트 창에서 오른쪽 클릭 ▸ 스크립트 실행.

## 3. 튜토리얼 2 — VHDL

```vhdl
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity blink is
  generic (N : natural := 4);
  port (clk, rst : in std_logic; led : out std_logic);
end entity;

architecture rtl of blink is
  signal cnt : unsigned(N-1 downto 0) := (others => '0');
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if rst = '1' then cnt <= (others => '0');
      else cnt <= cnt + 1;
      end if;
    end if;
  end process;
  led <= cnt(N-1);
end architecture;
```

테스트벤치 `tb_blink.vhd`:

```vhdl
library ieee;
use ieee.std_logic_1164.all;

entity tb_blink is end;
architecture sim of tb_blink is
  signal clk : std_logic := '0';
  signal rst : std_logic := '1';
  signal led : std_logic;
begin
  clk <= not clk after 5 ns;
  dut : entity work.blink generic map (N => 3) port map (clk, rst, led);
  process begin
    wait for 20 ns; rst <= '0';
    wait for 200 ns;
    report "led = " & std_logic'image(led);
    std.env.stop;
  end process;
end architecture;
```

```tcl
vcom blink.vhd tb_blink.vhd
vsim work.tb_blink
add wave -r /*
run -all
```

최상위 엔티티의 제네릭은 `vsim -gN=8 work.blink` 처럼 바꿀 수 있습니다(테스트벤치처럼 generic map 으로 값을 준 경우는 그 값이 쓰입니다).

VHDL 은 9값 `std_logic`(U X 0 1 Z W L H -)과 해결 함수를 그대로 따르며, `report`/`assert` 는 `** Note:` / `** Error:` 형식으로 출력됩니다.

## 4. 파형 창

| 동작 | 방법 |
|---|---|
| 커서 / 두 번째 커서 | 클릭 / Ctrl+클릭. 두 커서 사이의 시간 차이(Δ)가 아래에 표시됩니다. |
| 확대·축소 | I / O / F(전체), Ctrl+휠, 드래그로 영역 확대. C 는 커서를 가운데로. |
| 변화 이동 | Tab / Shift+Tab: 선택한 신호의 다음/이전 변화. |
| 값 찾기 | 툴바의 "값 찾기"에 값(현재 진법, 10진, `16#ff`, `4'b1010`)을 넣고 Enter. |
| 진법 | 이름 오른쪽 클릭 ▸ 진법(2진, 16진, 부호 없는/있는 10진, 8진, ASCII, 심볼). |
| 아날로그 표시 | 오른쪽 클릭 ▸ 표시 형식 ▸ 아날로그(계단 / 선형 보간). 높이와 범위(자동 또는 최소/최대)를 바꿀 수 있습니다. 실수 신호도 표시됩니다. |
| 색 | 오른쪽 클릭 ▸ 색. |
| 그룹 / 구분선 | 오른쪽 클릭 ▸ 선택 항목 그룹으로 묶기…, 아래에 구분선 삽입. 그룹 머리글의 ▾/▸ 로 접고 펼칩니다. |
| 버스 비트 | 이름 앞 ▸ 를 눌러 비트별로 펼칩니다. |
| 순서 / 삭제 | 이름을 끌어 순서 변경, Del 로 삭제. |
| 저장 / 복원 | 파형 ▸ 포맷 저장…(`write format wave wave.do`) 후 `do wave.do` 로 복원. 진법·색·형식·그룹이 모두 저장됩니다. |

시뮬레이션 뒤에 추가한 신호도 전체 히스토리가 보입니다(모든 신호의 히스토리가 기록되기 때문). 큰 설계에서는 `log`/`nolog`, `log -cap` 으로 기록량을 줄일 수 있습니다.

## 5. 디버깅: 브레이크포인트, 스텝, force

- **브레이크포인트**: 편집기 줄 번호 왼쪽 거터 클릭 또는 F8. 조건부: `bp tb.v 12 {q == 4'd3}`. 목록 `bp`, 삭제 `bd 1` / `bd all`.
- 멈추면 해당 줄이 강조되고 **지역 변수** 창에 프로세스의 변수와 호출 스택이 표시됩니다.
- **스텝**: F11(`step`) 은 다음 문장으로, F10(`step -over`) 은 태스크 호출을 건너뜁니다. 계속 실행은 `run -continue`.
- **when**: `when -label w1 {/tb/q == 4'd9} {stop}` — 조건이 참이 되면 명령을 실행합니다. `nowhen w1` 로 해제.
- **force**: 오브젝트 창 오른쪽 클릭 ▸ 강제…, 또는 `force /tb/rst 1 0, 0 30ns`, `force -deposit /tb/q 4'h5`, 반복 `force /tb/clk 0 0, 1 5 -repeat 10`. 해제 `noforce /tb/rst`.
- **examine**: `examine -radix hex /tb/q` 또는 `examine -time 100ns /tb/q`.
- **메모리**: 메모리 창에서 주소별 값 보기/수정, `mem save -outfile m.hex /tb/ram`, `mem load -infile m.hex /tb/ram`.
- **분해능**: `vsim -t 1ps top` (기본은 설계의 `timescale` 정밀도). 시간은 내부적으로 fs 단위로 정확하게 계산됩니다.
- 디버그 훅이 필요 없으면 `vsim -nodebug top` 으로 조금 더 빠르게 실행할 수 있습니다(스텝 불가).

## 6. 분석 도구: 리스트, 데이터플로, 커버리지, VCD

- **리스트 창**: `add list -radix unsigned /tb/q /tb/en` — 신호가 바뀐 시각마다 한 행. 리스트 탭의 저장 버튼 또는 `write list out.lst`.
- **데이터플로 창**: 오브젝트/파형에서 신호를 선택하거나 오른쪽 클릭 ▸ 데이터플로에서 보기. 왼쪽에 구동원(프로세스, assign, 포트 연결, UDP)과 그 입력, 오른쪽에 그 신호를 읽는 곳과 출력이 보이고 값은 파형 커서 시각 기준입니다. 신호를 클릭하면 따라가고(뒤로/앞으로), 더블 클릭하면 파형에 추가, 프로세스를 클릭하면 소스 줄로 이동합니다.
- **코드 커버리지**: `vsim -coverage top` (또는 시작 대화상자의 체크박스) 후 `coverage report`, 상세는 `coverage report -details`, 파일로 `coverage report -file cov.txt`. 문장(줄 단위), 분기(if 의 참/거짓, case 의 각 항목과 암묵적 default), 토글(각 비트의 0→1, 1→0)을 집계합니다. 편집기 거터에 실행 횟수(초록), 실행되지 않은 줄(빨강 ✗), 일부만 실행된 분기(노랑)가 표시됩니다.
- **VCD 내보내기**: `vcd export wave.vcd` (파형 창 신호) / `vcd export -all all.vcd`. 설계 안의 `$dumpfile`/`$dumpvars` 도 지원합니다.
- **VCD 가져오기**: 파일 ▸ VCD 파형 열기…, 프로젝트의 `.vcd` 더블 클릭, 또는 `vcd load wave.vcd` (`vsim -view wave.vcd`). 다른 시뮬레이터에서 만든 VCD 를 읽기 전용 데이터셋으로 열어 계층·오브젝트·파형·리스트에서 볼 수 있습니다. `quit -sim` 으로 닫습니다.

### Python 테스트벤치 (cocotb 호환)

[cocotb](https://www.cocotb.org/) 방식의 Python 테스트를 브라우저 안에서 실행합니다. Python 은 [Pyodide](https://pyodide.org/)(WebAssembly CPython, MPL-2.0, 첫 사용 시 약 13MB)로 시뮬레이션 워커에서 돌고, cocotb 의 공개 API 와 호환되는 WebSim 자체 구현(VPI 대신 커널에 직접 연결)이 제공됩니다. 예제는 **파일 ▸ 예제 불러오기 ▸ Python (cocotb) tests of the Verilog counter** 에 있습니다.

```tcl
vlog counter.v
vsim work.counter -cocotb test_counter          ;# test_counter.py 의 @cocotb.test() 를 순서대로 실행
vsim work.counter -cocotb tests/test_counter -testcase counts,wraps
run -all                                        ;# 테스트가 모두 끝나면 결과 표를 출력하고 시뮬레이션 종료
```

- 테스트 모듈은 프로젝트의 `.py` 파일입니다(폴더 가능, 같은 프로젝트의 다른 `.py` 를 import 가능). 시작 대화상자의 **cocotb 테스트** 에서도 고를 수 있습니다.
- 지원: `@cocotb.test(timeout_time=, timeout_unit=, expect_fail=, expect_error=, skip=)`, `cocotb.start_soon/start`, `Task`(await, `kill/cancel`, 결과값), `Clock(sig, period, unit).start()`(커널 안에서 토글), 트리거 `Timer`, `RisingEdge`, `FallingEdge`, `Edge/ValueChange`, `ClockCycles`, `ReadOnly`, `ReadWrite`, `NextTimeStep`, `First`, `Combine`, `Event`, `Lock`, `with_timeout`, `cocotb.queue.Queue`.
- 핸들: `dut.sig.value` 읽기(`LogicArray`/`Logic`, VHDL integer 는 `int`) 와 쓰기(정수, 비트 문자열, `LogicArray`, `Force/Release/Deposit/Freeze`), `setimmediatevalue`, 계층 접근 `dut.u1.q`, generate 블록 `dut.g[1].x`, 메모리 `dut.mem[3].value`, `dut._log.info(...)`. 1.x 스타일(`units=`, `BinaryValue`, `.integer`, `.binstr`)도 받습니다.
- 쓰기는 코루틴이 다음 `await` 에서 양보할 때 반영되고, `ReadOnly` 단계에서의 쓰기는 오류입니다. `ReadWrite` 는 활성·NBA 영역이 안정된 뒤 실행됩니다.
- 실패한 `assert` 는 테스트 파일의 줄과 함께 트레이스백으로 표시되고, 결과는 `** cocotb: TESTS=n PASS=p FAIL=f SKIP=s` 로 요약됩니다. 실패가 있으면 `run` 명령이 오류를 반환합니다. 테스트가 기다리는 동안 이벤트가 끝나거나 `$finish` 가 실행되면 진행 중인 테스트는 실패합니다.
- 실제 cocotb 패키지, pytest 기반 러너(`cocotb_tools.runner`), 파라미터화(`cocotb.parametrize`)와 UVM 은 포함하지 않습니다.

### 논리 합성 (Yosys)

오픈소스 합성기 [Yosys](https://github.com/YosysHQ/yosys)(YoWASP WebAssembly 빌드, ISC 라이선스)를 브라우저 안에서 실행합니다. 처음 한 번 약 77MB 를 내려받으며 이후에는 브라우저 캐시를 씁니다.

1. 설계를 컴파일한 뒤 **컴파일 ▸ 합성 (Yosys)…** 로 합성 창을 엽니다(또는 트랜스크립트에서 `synth`).
2. 최상위 모듈(비우면 자동: 테스트벤치가 아닌 최상위, 또는 테스트벤치가 인스턴스화한 모듈), 타깃(`generic`, `asic`, `ice40`, `ecp5`, `gowin`, `xilinx`), 평탄화 여부를 고르고 합성 버튼을 누릅니다. `asic` 은 WebSim 교육용 표준 셀 라이브러리(`websim_edu`: INV, NAND/NOR, AOI/OAI, XOR, MUX2, DFF, 비동기 리셋 DFFR, TIE 셀 등, 가상의 공정)에 매핑하고 칩 면적을 보고하며, 셀 시뮬레이션 모델 `synth/websim_edu.v`(specify 지연 포함)와 Liberty 파일 `synth/websim_edu.lib` 도 씁니다.
3. 셀 종류별 개수와 회로도가 표시되고, 결과는 프로젝트의 `synth/` 폴더에 `<top>.v`(넷리스트), `.json`, `.stat`, `.log` 로 저장됩니다(FPGA 타깃은 `<top>_<target>.*`).
4. **넷리스트 시뮬레이션**: **넷리스트 시뮬레이션** 버튼은 합성 결과의 넷리스트를 `work` 에 컴파일해 RTL 모듈을 대체하므로, 같은 테스트벤치로 게이트 레벨 시뮬레이션을 하고 RTL 결과와 비교할 수 있습니다. 모든 타깃에서 됩니다.
   - `generic`: Yosys 기본 게이트(`$_AND_` 등)는 WebSim 이 바로 시뮬레이션합니다.
   - `asic`: 셀 모델 `synth/websim_edu.v` 를 함께 컴파일합니다.
   - `ice40`, `ecp5`, `gowin`, `xilinx`: 합성할 때 그 FPGA 의 기본 소자(LUT, 플립플롭, 캐리, IO 버퍼, DSP …) 모델을 `synth/<타깃>_cells.v` 로 써 두고 함께 컴파일합니다. 모델은 Yosys 가 배포하는 `cells_sim.v`(ISC)이며, Yosys 에 블랙박스만 있는 DSP 곱셈기(ECP5 `MULT18X18D`, Gowin `MULT9X9/18X18/36X36`)는 Yosys 가 쓰는 조합 곱셈 모드에 대해 WebSim 이 모델을 붙입니다(레지스터 모드는 오류로 알림).
   - FPGA 모델에는 실제에 가까운 셀 지연(ps 단위, LUT 하나에 수백 ps~1 ns)이 들어 있어, 클록 에지 직후 너무 일찍 출력을 확인하면 아직 바뀌지 않은 값을 볼 수 있습니다. 클록 주기와 샘플 시점에 여유를 두세요.
   - 넷리스트에는 최상위 모듈의 파라미터가 합성에 쓴 값으로 선언되어 있어, `#(.WIDTH(4))` 처럼 파라미터를 지정하는 테스트벤치도 그대로 쓸 수 있습니다(다른 값을 주어도 넷리스트는 바뀌지 않습니다).
   - RTL 로 돌아가려면 원래 파일을 다시 컴파일하세요.

   ```tcl
   synth -target ice40
   vlog synth/ice40_cells.v synth/counter_ice40.v
   vsim work.tb_counter; run -all
   ```

```tcl
vlog counter.v tb_counter.v
synth -flatten                    ;# synth/counter.v ...
vlog synth/counter.v              ;# 게이트 레벨 넷리스트로 교체
vsim work.tb_counter; run -all
```

VHDL 은 아직 합성할 수 없습니다(Yosys 의 Verilog 프런트엔드만 포함).

### FPGA 배치 배선 (nextpnr: iCE40, ECP5, Gowin)

[nextpnr](https://github.com/YosysHQ/nextpnr) 와 각 계열의 비트스트림 도구(YoWASP WebAssembly 빌드, ISC 라이선스)로 합성 결과를 실제 FPGA 에 배치·배선하고 비트스트림을 만듭니다. 도구는 계열별로 처음 쓸 때 한 번 내려받습니다.

| 계열 | `-device` | 제약 파일 | 비트스트림 | 첫 다운로드 |
|---|---|---|---|---|
| Lattice iCE40 | `lp384`, `lp1k`, `hx1k`, `lp8k`, `hx8k`, `u4k`, `up5k`(기본) | `.pcf` (`set_io clk 35`) | `.bin` (icepack) | 약 235MB |
| Lattice ECP5 | `lfe5u-12f`, `lfe5u-25f`, `lfe5u-45f`, `lfe5u-85f` | `.lpf` (`LOCATE COMP "clk" SITE "G2";`) | `.bit` (ecppack) | 약 175MB |
| Gowin | `gw1nz-1`(Tang Nano 1K), `gw1ns-4`(4K), `gw1n-9c`(9K), `gw2a-18c`(20K) | `.cst` (`IO_LOC "clk" 52;`) | `.fs` (gowin_pack) | 약 185MB + Python 13MB |

1. **컴파일 ▸ 배치 배선 (nextpnr)…** 로 배치 배선 창을 엽니다(또는 트랜스크립트에서 `pnr`).
2. 디바이스, 필요하면 패키지(Gowin 은 전체 부품 번호), 핀 제약 파일, 목표 클록 주파수(MHz)를 고르고 버튼을 누릅니다. 해당 계열의 `synth -target <계열> -flatten` 이 먼저 실행됩니다.
3. 핀 제약 파일을 고르지 않으면 프로젝트의 `<top>.<pcf|lpf|cst>` 또는 `constraints/<top>.<확장자>` 를 자동으로 씁니다. iCE40/ECP5 는 제약이 없으면 핀을 자유롭게 배치하지만, **Gowin 은 모든 최상위 포트에 핀이 있어야 합니다.** **새 핀 제약** 은 최상위 포트 목록으로 계열 형식의 템플릿을 만들어 편집기에서 엽니다.
4. 자원 사용률 표(사용된 자원과 주요 자원)와 최대 동작 주파수(목표 주파수 대비 PASS/FAIL), 그리고 플로어플랜(사용된 타일: 파란색 로직, 초록색 IO, 보라색 RAM, 주황색 특수 블록; 노란 선은 타일 간 연결)이 표시됩니다. 타일에 마우스를 올리면 배치된 셀이 보입니다.
5. 결과는 `pnr/` 폴더에 `<top>.placed.json`, `<top>.log`(iCE40 은 `<top>.asc`, ECP5 는 `<top>.config` 텍스트 구성도)로 저장되며, **비트스트림** 버튼으로 FPGA 프로그래밍용 파일을 내려받습니다(예: `openFPGALoader -b tangnano9k counter.fs`, `iceprog counter.bin`).

```tcl
pnr -device hx8k -package ct256 -pcf counter.pcf -freq 50
pnr -device lfe5u-85f -lpf ulx3s.lpf -freq 25
pnr -device gw1n-9c -cst tangnano9k.cst -freq 27
```

Gowin 의 `gowin_pack` 은 Python 프로그램(apycula)이라 브라우저 안의 Python(Pyodide)으로 실행되며, 필요한 `msgspec` 패키지는 앱에 함께 들어 있습니다(외부 CDN 사용 없음). 타이밍을 맞추지 못하면 `pnr` 은 실패(FAIL)를 표시하고 오류를 반환하지만 결과 파일은 그대로 저장됩니다.

### 교육용 ASIC 흐름 (레이아웃, GDSII)

FPGA 대신 표준 셀 칩을 만드는 과정(합성 → 배치 → 배선 → GDSII)을 브라우저 안에서 그대로 체험할 수 있습니다. OpenROAD/Magic 같은 실제 ASIC 도구와 공정(PDK)은 브라우저에서 돌릴 수 없으므로, WebSim 이 직접 구현한 **교육용** 흐름과 가상의 셀 라이브러리·층 구성을 씁니다. 결과는 학습·시각화용이며 제조용이 아닙니다.

1. 설계를 컴파일한 뒤 **컴파일 ▸ ASIC 흐름 (레이아웃, GDSII)…** 로 레이아웃 창을 엽니다(또는 트랜스크립트에서 `asic`).
2. 목표 사용률(코어에서 셀이 차지하는 비율, 기본 0.6)과 배선 층(M2–M3, M2–M4, M2–M5)을 고르고 버튼을 누릅니다.
3. 다음 단계가 차례로 실행됩니다.
   - **합성**: `synth -target asic` — `websim_edu` 셀(INV, NAND/NOR, AOI/OAI, XOR, MUX2, DFF, DFFR, TIE …)로 매핑
   - **플로어플랜**: 사용률에 맞춘 정사각형 코어, 8트랙 높이의 행(행마다 상하 반전해 전원 레일 공유), IO 핀은 연결된 셀 쪽 가장자리에 배치
   - **배치**: 이차(quadratic) 전역 배치 + 확산(spreading), 행 단위 합법화(Abacus), 배선 길이(HPWL) 기반 세부 배치, 빈칸은 필러 셀
   - **배선**: M2/M4 가로, M3/M5 세로 트랙 격자에서 A* 미로 배선과 혼잡도 협상(PathFinder) 재배선, 셀 핀은 via1 로 연결, 전원은 M1 레일과 M3 스트랩
   - **검사와 타이밍**: 형상 기준 단락/개방 검사, 셀 지연 + 핀·배선 부하로 임계 경로와 최대 주파수 추정
4. 레이아웃 창에서
   - 휠로 확대/축소, 드래그로 이동, 확대하면 셀 내부(웰, 확산, 폴리, 콘택트, M1)와 셀 이름이 보입니다.
   - 왼쪽에서 층별로 켜고 끕니다. 도형을 클릭하거나 넷 이름을 입력하면 그 넷이 강조되고 층별 길이와 비아 수가 표시됩니다.
   - **임계 경로** 는 타이밍 임계 경로의 셀을 빨간 테두리로 표시합니다.
   - **GDSII** 로 `<top>.gds` 를 내려받아 KLayout 등 다른 레이아웃 뷰어에서 열 수 있고, **DEF**/**보고서** 는 편집기에서 엽니다.
5. 결과 파일: `asic/<top>.def`(배치·배선), `asic/<top>.rpt`(면적, 셀 수, 층별 배선 길이, IO 위치, 임계 경로), `asic/websim_edu.lef`(층과 셀 추상 뷰). 합성 넷리스트와 셀 시뮬레이션 모델(`synth/websim_edu.v`)로 게이트 레벨 시뮬레이션도 할 수 있습니다.

```tcl
vlog counter.v
asic -top counter -util 0.7 -layers 3
```

단락·개방·미배선이 남으면 `asic` 은 오류를 반환합니다. 이때는 사용률을 낮추거나(`-util 0.5`) 배선 층을 늘리세요(`-layers 4`). 래치처럼 라이브러리에 없는 기억 소자는 합성 단계에서 거부됩니다.

## 7. 프로젝트, 폴더, 검색

- **프로젝트**: 파일 ▸ 새 프로젝트… / 프로젝트 열기 / 프로젝트 이름 바꾸기… / 프로젝트 삭제. 프로젝트마다 파일, 컴파일된 라이브러리, 열린 편집기, 브레이크포인트가 따로 저장됩니다(테마와 창 배치는 공통).
- **폴더**: 파일 이름에 경로를 쓰면(`rtl/alu.v`) 폴더가 만들어집니다. 프로젝트 창의 새 폴더 버튼, 폴더 오른쪽 클릭 메뉴(여기에 새 파일, 폴더 컴파일, 이름 바꾸기, 삭제), 파일을 폴더로 끌어 놓기 또는 "폴더로 이동…". `vlog rtl/*.v` 의 `*` 는 폴더를 넘지 않으며, `` `include `` 는 포함하는 파일의 폴더와 `+incdir+` 경로에서도 찾습니다.
- **검색**: Ctrl+Shift+F 또는 파일 ▸ 파일에서 찾기…. 대소문자 구분(Aa), 단어 단위(ab), 정규식(.*) 옵션. 결과를 클릭하면 해당 줄을 엽니다.
- **가져오기/내보내기**: 파일 ▸ 파일 가져오기…(HDL, do, hex/mem, vcd, 프로젝트 .json), 프로젝트 다운로드(.json), 트랜스크립트 내보내기.

## 8. Transcript 명령 레퍼런스

명령은 `;` 로 여러 개를 이어 쓸 수 있고, `do <file>` 로 스크립트를 실행합니다. 경로는 절대(`/tb/dut/q`)나 현재 영역 기준 상대(`dut/q`)이며 `*`, `?` 와일드카드를 쓸 수 있습니다.

### 라이브러리와 컴파일

| 명령 | 설명 |
|---|---|
| `vlib <lib>` | 라이브러리 생성 |
| `vmap <lib> <path>` | 라이브러리 매핑(호환용, 메시지만 출력) |
| `vdel [-lib lib] [-all] <unit>` | 설계 단위 / 라이브러리 내용 삭제 |
| `vlog [-work lib] [+define+N[=V]] [+incdir+dir] <files...>` | Verilog / SystemVerilog 컴파일 |
| `vcom [-work lib] <files...>` | VHDL 컴파일 |

### 시뮬레이션

| 명령 | 설명 |
|---|---|
| `vsim [-t res] [-gName=Val] [-coverage] [-nodebug] [+nospecify] [lib.]top` | 설계 로드. `top` 은 모듈, 엔티티, `entity(arch)`, 구성(configuration) |
| `vsim -view <file.vcd>` | VCD 를 읽기 전용으로 열기 |
| `vsim top -cocotb <module> [-testcase a,b]` | 프로젝트의 Python 모듈에 있는 cocotb 테스트를 설계에 붙여 실행(`run -all`) |
| `run [<time> [unit]]` / `run -all` / `run -continue` | 시뮬레이션 진행 (단위 생략 시 분해능 단위) |
| `restart [-f]` | 0 시각으로 재시작 (파형 창 설정 유지) |
| `quit -sim` | 설계 언로드 |
| `step [-over]` | 한 문장 실행 |
| `bp [<file> <line> [{cond}]]` / `bd <id>\|<file> <line>\|all` | 브레이크포인트 설정·목록 / 삭제 |
| `when [-label n] {cond} {cmds}` / `nowhen <label>` | 조건 감시 |
| `force [-deposit] [-repeat p] [-cancel t] <sig> <v> [t][, <v> <t> ...]` / `noforce <sig>` | 강제 값 / 해제 |
| `examine [-radix r] [-time t] <sigs>` | 값 출력 |
| `env [<scope>]`, `pwd` | 현재 영역 표시·변경 |
| `find signals <pattern>`, `show [<scope>]`, `describe <name>` | 오브젝트 찾기 / 영역 내용 / 정보 |
| `now` | 현재 시뮬레이션 시간 |
| `radix <binary\|hex\|unsigned\|decimal\|octal\|ascii>` | 기본 진법 |

### 파형, 리스트, 로그

| 명령 | 설명 |
|---|---|
| `add wave [-r] [-radix r] [-color c] [-format Literal\|Analog-Step\|Analog-Interpolated] [-height px] [-min v] [-max v] [-group name] [-divider [label]] <paths>` | 파형 창에 추가 |
| `delete wave <paths>\|*` | 파형에서 삭제 |
| `write format wave <file.do>` | 파형 창 설정 저장 |
| `wave zoom full` | 전체 보기 |
| `add list [-r] [-radix r] <paths>` / `delete list <paths>\|*` / `write list <file>` | 리스트 창 |
| `log [-r] <paths>\|-all`, `nolog ...`, `log -cap <n>` | 히스토리 기록 대상 / 신호당 최대 기록 수 |
| `simstats` | 히스토리 크기와 메모리 추정치 |
| `vcd export [-all] [file.vcd]` / `vcd load <file.vcd>` | VCD 내보내기 / 가져오기 |

### 메모리와 커버리지

| 명령 | 설명 |
|---|---|
| `mem list` | 메모리 목록 |
| `mem display [-startaddress a] [-endaddress b] <mem>` | 내용 출력 |
| `mem save -outfile <f> [-format hex\|bin] <mem>` / `mem load -infile <f> <mem>` | 저장 / 불러오기 |
| `coverage report [-details] [-file f]` / `coverage clear` | 커버리지 리포트 / 초기화 (`vsim -coverage` 필요) |

### 합성

| 명령 | 설명 |
|---|---|
| `synth [-top m] [-target generic\|asic\|ice40\|ecp5\|gowin\|xilinx] [-flatten] [files...]` | Yosys 로 합성. 파일을 생략하면 `-top` 모듈과 그 하위 모듈의 소스 파일을 라이브러리에서 찾습니다. 결과는 `synth/` 폴더 |
| `pnr [-top m] [-device up5k\|lfe5u-25f\|gw1n-9c\|...] [-package p] [-pcf\|-lpf\|-cst file] [-freq MHz] [-seed n]` | 디바이스 계열(iCE40, ECP5, Gowin)로 합성한 뒤 nextpnr 로 배치 배선하고 비트스트림을 만듭니다. 결과는 `pnr/` 폴더 |
| `asic [-top m] [-util 0.6] [-layers 2\|3\|4] [files...]` | 교육용 ASIC 흐름: 표준 셀 합성, 배치, 배선, 검사, 타이밍 추정, DEF/LEF/GDSII. 결과는 `asic/` 폴더, GDSII 는 레이아웃 창에서 다운로드 |

### 기타

`do <file>`, `echo <text>`, `ls`, `history`, `clear`, `help`, `quit`.

## 9. 지원 언어 범위

✓ 지원 · △ 일부 지원 · ✗ 미지원

### Verilog / SystemVerilog

| 기능 | 상태 | 비고 |
|---|---|---|
| 모듈, ANSI/비ANSI 포트, parameter/localparam, `#()` 재정의, defparam | ✓ | |
| wire/reg/logic/bit/integer/int/byte/longint/real/time/string, signed | ✓ | int 계열은 2-state(초기값 0) |
| 메모리, 다차원 배열, 인스턴스 배열, generate for/if | ✓ | |
| always/always_ff/always_comb/always_latch/initial, fork/join/join_any/join_none | ✓ | |
| 블로킹/논블로킹, 지연(`#`, rise/fall/turn-off), 이벤트 제어, wait, named event | ✓ | |
| 함수/태스크(재귀, automatic, 기본 인자), 계층 참조 | ✓ | |
| 게이트 프리미티브, UDP(조합/순차), 구동 강도, tri0/tri1, pullup/pulldown | ✓ | |
| specify 경로 지연, specparam | △ | 출력 포트에 최대 경로 지연 적용, 타이밍 체크 무시 |
| `` `define/`ifdef/`include/`timescale `` | ✓ | |
| 시스템 태스크: $display/$write/$strobe/$monitor/$fopen/$fdisplay/$readmemh/$random/$finish ... | ✓ | |
| typedef enum, struct packed, package/import | ✓ | |
| interface, modport | △ | modport 방향은 강제하지 않음 |
| class(상속, virtual, super, static, new) | △ | 파라미터 클래스, randomize/constraint 미지원 |
| 즉시 assertion, SVA(`|->`, `|=>`, `##`, `[*]`, $rose/$fell/$past ...) | △ | throughout/within, `[->]`, property 인자 미지원 |
| queue, dynamic array, associative array, mailbox, semaphore, covergroup | ✗ | |

### VHDL

| 기능 | 상태 | 비고 |
|---|---|---|
| entity/architecture, generic, port, component, 직접 인스턴스화 | ✓ | |
| configuration, block(guard 포함) | ✓ | configuration 의 generic/port map 미지원 |
| package / package body, use, alias | ✓ | |
| std_logic 9값과 해결 함수, numeric_std, std_logic_unsigned, textio | ✓ | |
| 레코드, 배열(비제약 포함), 열거형, 정수/물리/실수 타입 | ✓ | |
| 연산자 오버로딩, 기본값/이름 연결 인자 | ✓ | |
| process(민감도 / wait), 조건·선택 신호 할당, transport/reject 지연 | ✓ | |
| 속성 'event 'last_value 'length 'range 'image 'value 'pos 'val 'succ 'pred ... | ✓ | |
| VHDL-2008: process(all), case?, ?=, 외부 이름, 조건부 변수 할당, 단항 축약 연산자 | ✓ | |
| 다차원 배열 타입, access/protected 타입, PSL | ✗ | |

## 10. 단축키

| 키 | 동작 |
|---|---|
| F7 / Shift+F7 | 현재 파일 / 모든 파일 컴파일 |
| F9 | 실행 시간만큼 실행 |
| F5 | 끝까지 실행 |
| Esc | 실행 중단 |
| F8 | 편집기 커서 줄에 브레이크포인트 |
| F11 / F10 | 스텝 / 스텝 오버 |
| Ctrl+S | 저장 |
| Ctrl+Alt+N | 새 파일 |
| Ctrl+Shift+F | 파일에서 찾기 |
| 파형: F / I / O / C | 전체 / 확대 / 축소 / 커서 가운데 |
| 파형: Tab / Shift+Tab | 다음 / 이전 변화 |
| 파형: Del | 선택 신호 삭제 |
| 트랜스크립트: ↑ / ↓ / Tab | 명령 기록 / 자동 완성 |

---

문제나 제안은 <https://github.com/infinity9753/websim/issues> 에 올려 주세요.
