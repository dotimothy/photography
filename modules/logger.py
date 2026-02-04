import sys
import os
import time
from datetime import datetime

# --- Formatting, Profiling & Logging ---
class color:
     BOLD = '\033[1m'
     END = '\033[0m'

class DualLogger(object):
    """Writes to both stdout (terminal) and a log file."""
    def __init__(self, log_dir='logs'):
        self.terminal = sys.stdout
        os.makedirs(log_dir, exist_ok=True)
        log_name = os.path.join(log_dir, "build.log")
        self.log_file = open(log_name, "a", encoding='utf-8')
        
        # Add session separator
        session_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        self.log_file.write(f"\n{'='*80}\n")
        self.log_file.write(f"NEW BUILD SESSION STARTED AT {session_time}\n")
        self.log_file.write(f"{'='*80}\n\n")

    def write(self, message):
        self.terminal.write(message)
        self.log_file.write(message)
        self.log_file.flush()

    def flush(self):
        self.terminal.flush()
        self.log_file.flush()

class Profiler:
    def __init__(self):
        self.metrics = {}
        self.start_times = {}

    def start(self, name):
        self.start_times[name] = time.time()

    def stop(self, name, count=0):
        if name in self.start_times:
            duration = time.time() - self.start_times[name]
            self.metrics[name] = {'time': duration, 'count': count}

    def report(self):
        print(f"\n{color.BOLD}*** Performance Report ***{color.END}")
        print(f"{'-'*75}")
        print(f"{'Step Name':<25} | {'Time':<12} | {'% Total':<10} | {'Throughput':<15}")
        print(f"{'-'*75}")
        
        total_time = sum(m['time'] for m in self.metrics.values())
        
        for name, data in self.metrics.items():
            t = data['time']
            pct = (t / total_time * 100) if total_time > 0 else 0
            
            time_str = f"{t:.2f} s"
            pct_str = f"{pct:.1f} %"
            
            if data['count'] > 0 and t > 0:
                throughput_str = f"{data['count']/t:.1f} it/s"
            else:
                throughput_str = "-"

            print(f"{name:<25} | {time_str:<12} | {pct_str:<10} | {throughput_str:<15}")
            
        print(f"{'-'*75}")
        print(f"{'Total Duration':<25} | {total_time:.2f} s     | 100.0 %    |")
        print(f"{'-'*75}")

class VerboseLogger:
    """Logs granular actions to a specific file, bypassing stdout."""
    def __init__(self, log_dir='logs'):
        os.makedirs(log_dir, exist_ok=True)
        # Unified log file
        self.path = os.path.join(log_dir, "build.log")
        self.file = open(self.path, "a", encoding='utf-8')
        # print(f" - Detailed logs will be written to: {self.path}")

    def log(self, category, message):
        timestamp = datetime.now().strftime('%H:%M:%S')
        line = f"[{timestamp}] [{category:<10}] {message}\n"
        self.file.write(line)
        self.file.flush()
    
    def close(self):
        self.file.close()
