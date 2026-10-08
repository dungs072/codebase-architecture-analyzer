using Game.Core;
using System.Collections.Generic;

namespace Game.Staff
{
    public class StaffData
    {
        public string Name;
        public int Salary;
    }

    public class StaffRepository
    {
        private readonly List<StaffData> _staff = new();
        public void Add(StaffData s) => _staff.Add(s);
        public IReadOnlyList<StaffData> All => _staff;
    }

    public class HiringService
    {
        private readonly CurrencyService _currency;
        private readonly StaffRepository _repo;

        public HiringService(CurrencyService currency, StaffRepository repo) { _currency = currency; _repo = repo; }

        public bool Hire(StaffData candidate)
        {
            if (!_currency.TrySpend(candidate.Salary)) return false;
            _repo.Add(candidate);
            return true;
        }
    }

    public class HiringController
    {
        private readonly HiringService _hiring;
        public HiringController(HiringService hiring) { _hiring = hiring; }
        public void OnHireRequested(StaffData d) { _hiring.Hire(d); }
    }

    public class HiringScreen : UnityEngine.MonoBehaviour
    {
        [VContainer.Inject] private HiringController _controller;

        public void OnHireClicked()
        {
            var interpolated = $"Hire {"Bob"} for {10}$ {{literal}}";
            _controller.OnHireRequested(new StaffData { Name = "Bob", Salary = 10 });
        }
    }
}
