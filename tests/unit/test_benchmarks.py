from scripts.benchmark_performance import _source


def test_performance_benchmark_uses_exact_ten_thousand_loc():
    assert _source().count("\n") == 10_000
